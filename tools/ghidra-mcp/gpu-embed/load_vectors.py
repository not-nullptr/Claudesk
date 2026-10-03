#!/usr/bin/env python3
"""Stage 3: load GPU-computed vectors back into the MCP server's ChromaDB.

Runs in the analysis container (same box as extract_functions.py), because it
writes the collection the MCP server reads. It does **no embedding of its own**
-- every vector is passed explicitly to ``collection.add``, which is the whole
point: Chroma never calls its slow CPU embedder.

    uv run load_vectors.py --documents documents.jsonl --vectors vectors/

Stop the MCP server first (or at least don't use its tools): this deletes and
recreates the collection, and a server holding the old handle would keep serving
stale results. Restart it afterwards -- it will find the collection complete and
skip indexing entirely.

The collection name must match what pyghidra-mcp derives from the project
(``--project-name`` -> ``<name>-pyghidra-mcp/chromadb``, collection
``_normalize_collection_name(program_info.name)``), hence the default below.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Iterator

DEFAULT_CHROMA_PATH = "/workspace/ghidra-projects/claude-ipa-pyghidra-mcp/chromadb"
DEFAULT_COLLECTION = "Claude"
COMPLETE_KEY = "pyghidra_index_complete"  # pyghidra-mcp's completion marker
EXPECTED_DIM = 384  # all-MiniLM-L6-v2


def load_records(path: Path) -> dict[str, dict]:
    """id -> record, from the stage-1 JSONL. Later lines win."""
    records: dict[str, dict] = {}
    with path.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                print(f"  ! skipping malformed line {lineno}", file=sys.stderr)
                continue
            if "id" in obj:
                records[obj["id"]] = obj
    return records


def iter_shards(vectors_dir: Path, manifest: dict) -> Iterator[tuple[str, "object", "object"]]:
    """Yield (name, ids, embeddings) for each shard listed in the manifest."""
    import numpy as np

    names = manifest.get("shards") or sorted(p.name for p in vectors_dir.glob("shard-*.npz"))
    for name in names:
        path = vectors_dir / name
        if not path.is_file():
            raise SystemExit(f"error: {path} is listed in the manifest but missing")
        with np.load(path) as data:
            ids = data["ids"]
            embeddings = data["embeddings"]
        yield name, ids, embeddings


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--documents", type=Path, default=Path("documents.jsonl"))
    ap.add_argument("--vectors", type=Path, default=Path("vectors"))
    ap.add_argument("--chroma-path", default=DEFAULT_CHROMA_PATH)
    ap.add_argument("--collection", default=DEFAULT_COLLECTION)
    ap.add_argument(
        "--batch-size",
        type=int,
        default=2000,
        help="documents per Chroma add (default: 2000; Chroma caps a batch around 5461)",
    )
    ap.add_argument("--dry-run", action="store_true", help="align and report, write nothing")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    manifest_path = args.vectors / "manifest.json"
    if not manifest_path.is_file():
        print(f"error: {manifest_path} not found (run embed_gpu.py first)", file=sys.stderr)
        return 2
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    dim = int(manifest.get("dim", 0))
    if dim != EXPECTED_DIM:
        print(
            f"error: manifest says dim={dim}, expected {EXPECTED_DIM}. The vectors were "
            "produced by a different model than the query side uses; loading them would "
            "silently degrade search.",
            file=sys.stderr,
        )
        return 3
    if not manifest.get("normalized", False):
        print("warning: manifest does not say the vectors are L2-normalised", file=sys.stderr)

    print(f"model: {manifest.get('model')} (dim={dim}, max_seq_length={manifest.get('max_seq_length')})")
    print(f"reading {args.documents} ...")
    t0 = time.time()
    records = load_records(args.documents)
    print(f"  {len(records):,} records in {time.time() - t0:.1f}s")

    import chromadb
    from chromadb.config import Settings

    client = chromadb.PersistentClient(
        path=str(args.chroma_path), settings=Settings(anonymized_telemetry=False)
    )

    if args.dry_run:
        total = 0
        missing = 0
        for name, ids, embeddings in iter_shards(args.vectors, manifest):
            total += len(ids)
            missing += sum(1 for i in ids if str(i) not in records)
            print(f"  {name}: {len(ids)} ids, shape={getattr(embeddings, 'shape', '?')}")
        print(f"dry run: {total:,} vectors, {missing:,} ids with no matching document")
        return 0

    # chromadb >= 0.6 returns Collection objects here, older versions names.
    existing = [getattr(c, "name", c) for c in client.list_collections()]
    if args.collection in existing:
        print(f"deleting existing collection '{args.collection}'")
        client.delete_collection(name=args.collection)

    collection = client.create_collection(
        name=args.collection, metadata={COMPLETE_KEY: False}
    )

    added = 0
    skipped_missing = 0
    skipped_dupe = 0
    seen: set[str] = set()
    started = time.time()

    for name, ids, embeddings in iter_shards(args.vectors, manifest):
        ids = [str(i) for i in ids]
        embeddings = embeddings.astype("float32", copy=False)
        if embeddings.shape[0] != len(ids):
            raise SystemExit(f"error: {name}: {len(ids)} ids but {embeddings.shape[0]} vectors")

        batch_ids: list[str] = []
        batch_docs: list[str] = []
        batch_meta: list[dict] = []
        batch_emb: list = []

        def flush() -> None:
            nonlocal added
            if not batch_ids:
                return
            collection.add(
                ids=batch_ids,
                documents=batch_docs,
                metadatas=batch_meta,
                embeddings=batch_emb,
            )
            added += len(batch_ids)
            batch_ids.clear()
            batch_docs.clear()
            batch_meta.clear()
            batch_emb.clear()

        for i, fid in enumerate(ids):
            record = records.get(fid)
            if record is None:
                skipped_missing += 1
                continue
            if fid in seen:
                skipped_dupe += 1
                continue
            seen.add(fid)
            batch_ids.append(fid)
            batch_docs.append(record.get("document") or "")
            batch_meta.append(
                {
                    "function_name": record.get("function_name", fid),
                    "entry_point": record.get("entry_point", ""),
                }
            )
            batch_emb.append(embeddings[i])
            if len(batch_ids) >= args.batch_size:
                flush()

        flush()
        print(f"  {name}: {added:,} added so far ({time.time() - started:,.0f}s)")

    collection.modify(metadata={COMPLETE_KEY: True, "function_count": added})

    elapsed = time.time() - started
    print(
        f"\ndone: {added:,} vectors loaded into '{args.collection}' in {elapsed:,.1f}s\n"
        f"      skipped: {skipped_missing:,} with no document, {skipped_dupe:,} duplicate ids"
    )
    if added == 0:
        print("      warning: nothing was loaded", file=sys.stderr)
        return 4
    print("      restart the MCP server so it picks up the new collection")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
