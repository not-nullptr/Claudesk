# Package contents

| File | Purpose |
|---|---|
| `README.md` | start here |
| `pyproject.toml`, `uv.lock`, `.python-version` | dependencies (torch from PyTorch's CUDA 12.4 index) |
| `embed_gpu.py` | **the GPU script** — stage 2 |
| `verify_vectors.py` | confirms the vectors match ChromaDB's query space |
| `reference_vectors.npz` | 256 real docs + ChromaDB's own embeddings, for the check |
| `extract_functions.py` | stage 1 — runs in the analysis container |
| `load_vectors.py` | stage 3 — runs in the analysis container |
| `sample/documents.sample.jsonl` | 120 real functions to smoke-test with |
