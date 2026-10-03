#!/usr/bin/env python3
"""Confirm the GPU model produces vectors in the same space as the query side.

The query side of the index is ChromaDB's built-in ``ONNXMiniLM_L6_V2``
embedding function (all-MiniLM-L6-v2, 384-dim, mean-pooled, L2-normalised,
256-token truncation). If the vectors computed here on the GPU did not live in
that same space, document/query similarity would be meaningless and semantic
search would silently degrade -- no error, just worse results.

``reference_vectors.npz`` holds real documents plus the embeddings ChromaDB
itself produced for them. This script re-embeds those documents with the local
model and compares. Anything above ~0.99 cosine means the spaces match
(PyTorch and ONNX kernels differ in the last bits, so exactly 1.0 is not
expected); below ~0.95 means something is wrong -- wrong model, wrong pooling,
or the 256-token truncation not applied -- and the run should not be trusted.

    uv run verify_vectors.py reference_vectors.npz
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Below this, the vectors are not in the query space and loading them would
# quietly degrade search rather than fail.
MIN_ACCEPTABLE_COSINE = 0.95


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("reference", type=Path, nargs="?", default=Path("reference_vectors.npz"))
    ap.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2")
    ap.add_argument("--max-seq-length", type=int, default=256)
    ap.add_argument("--device", default=None, help="torch device (default: cuda if available)")
    # Match embed_gpu.py's precision, or the check would validate a code path
    # the real run doesn't use.
    ap.add_argument("--fp16", dest="fp16", action="store_true", default=None)
    ap.add_argument("--no-fp16", dest="fp16", action="store_false")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    if not args.reference.is_file():
        print(f"error: {args.reference} not found", file=sys.stderr)
        return 2

    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer

    with np.load(args.reference) as data:
        documents = [str(d) for d in data["documents"]]
        reference = data["embeddings"].astype("float32")

    if reference.shape[0] != len(documents):
        print("error: reference file is malformed (documents/embeddings mismatch)", file=sys.stderr)
        return 2

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    print(f"reference: {len(documents)} documents, {reference.shape[1]}-dim")
    print(f"encoding with {args.model} on {device} ...")

    use_fp16 = args.fp16 if args.fp16 is not None else device.startswith("cuda")
    model = SentenceTransformer(args.model, device=device)
    model.max_seq_length = args.max_seq_length
    if use_fp16:
        model.half()
    print(f"precision: {'float16' if use_fp16 else 'float32'}")
    with torch.inference_mode():
        vectors = model.encode(
            documents,
            batch_size=64,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
    vectors = np.asarray(vectors, dtype="float32")

    # A half-precision model can emit half-precision vectors; normalising them
    # after the fact keeps the comparison meaningful either way.
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vectors = vectors / norms

    if vectors.shape != reference.shape:
        print(
            f"error: shape mismatch -- model produced {vectors.shape}, reference is {reference.shape}",
            file=sys.stderr,
        )
        return 3

    # Both sides are L2-normalised, so the dot product is the cosine.
    cosines = np.sum(vectors * reference, axis=1)
    worst = int(np.argmin(cosines))
    print(
        f"\ncosine to ChromaDB's own embeddings:\n"
        f"  min  {cosines.min():.6f}   (worst doc: {documents[worst][:60]!r})\n"
        f"  mean {cosines.mean():.6f}\n"
        f"  max  {cosines.max():.6f}"
    )

    if cosines.min() < MIN_ACCEPTABLE_COSINE:
        print(
            f"\nFAIL: min cosine {cosines.min():.6f} < {MIN_ACCEPTABLE_COSINE}. These vectors are "
            "not in the query space -- do not load them.",
            file=sys.stderr,
        )
        return 1

    print("\nOK: the GPU vectors match the query space.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
