#!/usr/bin/env python3
"""Stage 2: embed the extracted function corpus on a CUDA GPU.

Reads ``documents.jsonl`` (stage 1, produced in the Ghidra container) and writes
sharded ``.npz`` files of L2-normalised float32 vectors:

    vectors/shard-0000000.npz     ids: [N] <U  embeddings: [N, 384] float32
    vectors/manifest.json         model, dim, max_seq_length, shard list, count

The model is the *same* one ChromaDB uses for queries -- ``all-MiniLM-L6-v2``,
mean-pooled, L2-normalised, truncated to 256 tokens -- so the vectors loaded
back into the collection live in the same space as the query vectors. The model
weights are downloaded on first run (``--model`` overrides the HF id); nothing
is vendored here.

Run ``verify_vectors.py`` once against ``reference_vectors.npz`` to confirm the
space actually matches before trusting a full run.

    uv run embed_gpu.py documents.jsonl --out vectors

Interrupting and re-running is safe: finished shards are skipped, so a long run
resumes where it stopped (``--force`` re-embeds everything).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
# ChromaDB's ONNX embedding function pads/truncates every document to 256
# tokens (see chromadb/utils/embedding_functions/onnx_mini_lm_l6_v2.py). The
# tail of a longer function is already discarded on the query side, so mirror
# it here or the two spaces diverge on long documents.
DEFAULT_MAX_SEQ_LENGTH = 256


def iter_documents(path: Path):
    """Yield (id, document) pairs from the stage-1 JSONL, skipping bad lines."""
    with path.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"  ! skipping malformed line {lineno}: {exc}", file=sys.stderr)
                continue
            doc = obj.get("document")
            fid = obj.get("id")
            if doc is None or fid is None:
                continue
            yield fid, doc


def shard_path(out_dir: Path, start: int) -> Path:
    return out_dir / f"shard-{start:07d}.npz"


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("documents", type=Path, help="documents.jsonl from extract_functions.py")
    ap.add_argument("--out", type=Path, default=Path("vectors"), help="output directory (default: vectors)")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"HF model id (default: {DEFAULT_MODEL})")
    ap.add_argument("--shard-size", type=int, default=50_000, help="documents per output shard (default: 50000)")
    ap.add_argument("--batch-size", type=int, default=512, help="documents per forward pass (default: 512)")
    ap.add_argument("--max-seq-length", type=int, default=DEFAULT_MAX_SEQ_LENGTH, help="token cap (default: 256, matches Chroma)")
    ap.add_argument("--device", default="cuda", help="torch device (default: cuda; use cpu to smoke-test)")
    ap.add_argument("--fp16", dest="fp16", action="store_true", default=True, help="run the model in half precision (default)")
    ap.add_argument("--no-fp16", dest="fp16", action="store_false", help="run in float32")
    ap.add_argument("--limit", type=int, default=0, help="stop after N documents (smoke tests)")
    ap.add_argument("--force", action="store_true", help="re-embed shards that already exist")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    if not args.documents.is_file():
        print(f"error: {args.documents} not found", file=sys.stderr)
        return 2

    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer

    if args.device.startswith("cuda") and not torch.cuda.is_available():
        print(
            "error: --device cuda but torch.cuda.is_available() is False.\n"
            "       Check `nvidia-smi`, then that this is the CUDA torch build:\n"
            "       uv run python -c 'import torch; print(torch.__version__, torch.version.cuda)'",
            file=sys.stderr,
        )
        return 3

    print(f"loading {args.model} on {args.device} ...")
    t0 = time.time()
    model = SentenceTransformer(args.model, device=args.device)
    model.max_seq_length = args.max_seq_length
    if args.fp16 and args.device.startswith("cuda"):
        model.half()
    # sentence-transformers renamed this in 6.x; support both.
    get_dim = getattr(model, "get_embedding_dimension", None) or model.get_sentence_embedding_dimension
    dim = get_dim()
    print(f"  ready in {time.time() - t0:.1f}s, dim={dim}, max_seq_length={args.max_seq_length}")

    args.out.mkdir(parents=True, exist_ok=True)

    if args.limit:
        # A truncated run writes a short first shard under the same name a full
        # run would use, so resuming would silently skip real documents.
        print("note: --limit set; existing shards will be overwritten (no resume)")
        args.force = True

    # ChromaDB's default embedder is 384-dim; a mismatch means --model is wrong
    # and the shards would be unusable, so stop before writing anything.
    if dim != 384:
        print(
            f"error: {args.model} produces {dim}-dim vectors; the collection expects 384 "
            "(all-MiniLM-L6-v2). Use --model sentence-transformers/all-MiniLM-L6-v2.",
            file=sys.stderr,
        )
        return 4

    from tqdm import tqdm

    shards: list[str] = []
    total_written = 0
    total_seen = 0
    skipped_docs = 0
    started = time.time()

    ids_buf: list[str] = []
    docs_buf: list[str] = []
    # Shard filenames are keyed by the index of their first document, so a
    # resumed run lands on the same name and can skip the finished ones.
    shard_index = 0

    def flush_shard() -> None:
        nonlocal ids_buf, docs_buf, shard_index, total_written, skipped_docs
        if not ids_buf:
            return
        n = len(ids_buf)
        path = shard_path(args.out, shard_index * args.shard_size)
        if path.exists() and not args.force:
            print(f"  skip existing {path.name} ({n} docs)")
            skipped_docs += n
            ids_buf, docs_buf = [], []
            shard_index += 1
            return
        t = time.time()
        with torch.inference_mode():
            vectors = model.encode(
                docs_buf,
                batch_size=args.batch_size,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
        vectors = np.asarray(vectors, dtype=np.float32)
        # Plain unicode array, not dtype=object: object arrays need pickle to
        # load back, and load_vectors.py reads these without allow_pickle.
        np.savez(path, ids=np.array(ids_buf), embeddings=vectors)
        shards.append(path.name)
        total_written += len(ids_buf)
        rate = n / max(time.time() - t, 1e-9)
        print(f"  wrote {path.name}: {n} docs in {time.time() - t:.1f}s ({rate:,.0f} docs/s)")
        ids_buf, docs_buf = [], []
        shard_index += 1

    progress = tqdm(desc="documents", unit="doc")
    try:
        for fid, doc in iter_documents(args.documents):
            total_seen += 1
            if args.limit and total_seen > args.limit:
                break
            ids_buf.append(fid)
            docs_buf.append(doc)
            progress.update(1)
            if len(ids_buf) >= args.shard_size:
                flush_shard()
    finally:
        progress.close()

    flush_shard()

    elapsed = time.time() - started
    # List every shard on disk, not just this run's: a resumed run must still
    # produce a manifest describing the whole set for load_vectors.py.
    all_shards = sorted(p.name for p in args.out.glob("shard-*.npz"))
    manifest = {
        "model": args.model,
        "dim": int(dim),
        "max_seq_length": args.max_seq_length,
        "normalized": True,
        "shard_size": args.shard_size,
        "documents_seen": total_seen,
        "embeddings_written": total_written,
        "skipped_existing_docs": skipped_docs,
        "shards": all_shards,
        "elapsed_seconds": round(elapsed, 1),
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(
        f"\ndone: {total_seen:,} documents seen, {total_written:,} embedded in {elapsed:,.1f}s "
        f"({total_seen / max(elapsed, 1e-9):,.0f} docs/s)\n"
        f"      manifest: {args.out / 'manifest.json'}"
    )
    if total_written == 0 and shards == [] and total_seen > 0:
        print("      (every shard already existed -- nothing to do)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
