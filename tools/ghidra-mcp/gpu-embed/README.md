# GPU embedding package

Compute the pyghidra-mcp code index's embeddings on a CUDA GPU instead of the
container's CPU.

The container's indexer is **embedding-bound, not decompile-bound**: ChromaDB's
default embedder (`all-MiniLM-L6-v2` via onnxruntime, CPU-only) runs at ~30
docs/s, and the corpus is ~460k functions — about 5 hours. An RTX 4090 does the
same work in a couple of minutes. Decompilation cannot move to the GPU box (it
needs the 3.7 GB analyzed Ghidra project), so the work is split in three stages:

| Stage | Script | Runs on | What it does |
|---|---|---|---|
| 1 | `extract_functions.py` | the analysis container | decompiles every function to `documents.jsonl` |
| 2 | `embed_gpu.py` | **your GPU machine** | embeds the corpus, writes sharded vector files |
| 3 | `load_vectors.py` | the analysis container | loads the vectors into ChromaDB (no CPU embedding) |

Only stage 2 needs the GPU box. Stages 1 and 3 are here because they have to be
where the Ghidra project and ChromaDB live — but both are fast, and neither one
embeds anything.

## Quick start (on the GPU machine)

```bash
# 1. uv, if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. dependencies (torch comes from PyTorch's CUDA 12.4 index -- see pyproject.toml)
uv sync

# 3. sanity-check that the GPU is visible
uv run python -c "import torch; print(torch.cuda.get_device_name(0), torch.version.cuda)"

# 4. confirm the vectors will match the query side (one time, ~30s)
uv run verify_vectors.py reference_vectors.npz
#   -> "OK: the GPU vectors match the query space."

# 5. embed
uv run embed_gpu.py documents.jsonl --out vectors
```

The model (`sentence-transformers/all-MiniLM-L6-v2`, ~90 MB) downloads from
Hugging Face on first run and is cached in `~/.cache/huggingface`. Nothing is
vendored.

`documents.jsonl` is the input — copy it over from the container, or generate it
there with stage 1 (see below).

## Output

```
vectors/shard-0000000.npz     ids: [N]      embeddings: [N, 384] float32 (L2-normalised)
vectors/shard-0050000.npz
...
vectors/manifest.json         model, dim, shard list, counts, timings
```

Shards are 50 000 documents each (~77 MB), so you can move them in pieces and
the loader can resume. Re-running `embed_gpu.py` **skips shards that already
exist** — interrupt it, or lose the connection, and it picks up where it
stopped. `--force` re-embeds everything.

## Why `verify_vectors.py` matters

Document vectors and query vectors must live in the same space, or semantic
search silently returns garbage — no error, just bad results. The query side is
ChromaDB's built-in ONNX embedder; this package uses PyTorch. `reference_vectors.npz`
contains 256 real function bodies plus the vectors **ChromaDB itself** produced
for them (sampled across the corpus's length distribution, including a 54k-char
document that exercises the 256-token truncation). The check re-embeds them here
and compares cosine similarity.

Already run in this container: `min = mean = max = 1.000000`. The two
implementations agree to float precision. If you change `--model` or
`--max-seq-length`, re-run it.

## Full pipeline, end to end

On the analysis container (Claude Code here):

```bash
cd tools/ghidra-mcp/gpu-embed

# Stage 1 -- decompile (resumable; ~42 min for the 459k-function Claude binary)
/workspace/tools/pyghidra-mcp/.venv/bin/python extract_functions.py \
    --out /workspace/ghidra-index/documents.jsonl --workers 12

# copy to the GPU box
scp /workspace/ghidra-index/documents.jsonl gpu-box:~/
```

On the GPU machine: `uv sync`, `verify_vectors.py`, `embed_gpu.py` as above,
then copy `vectors/` back.

On the analysis container:

```bash
# Stage 3 -- stop the MCP server first, then:
/workspace/tools/pyghidra-mcp/.venv/bin/python load_vectors.py \
    --documents /workspace/ghidra-index/documents.jsonl \
    --vectors /workspace/ghidra-index/vectors
```

Restart the MCP server afterwards. It checks pyghidra-mcp's completion marker
(`pyghidra_index_complete`), finds it set, and skips indexing entirely.

## Details that matter

**Model.** `all-MiniLM-L6-v2`, 384-dim, mean-pooled, L2-normalised,
`max_seq_length=256`. The 256 cap is not arbitrary: ChromaDB's embedding
function pads *every* document to exactly 256 tokens, so anything longer is
already truncated on the query side. `embed_gpu.py` aborts if the model isn't
384-dim rather than writing unusable shards.

**Ids and metadata** written by stage 1 match pyghidra-mcp's own indexer exactly
(`<symbol name, truncated to 50 chars>-<entry point>`, metadata
`function_name`/`entry_point`), so stage 3 can populate the collection the MCP
server reads with no translation.

**Resumability.** Stage 1 tracks completed ids in its output file (a torn final
line from a hard kill is truncated on restart), stage 2 skips finished shards,
stage 3 is all-or-nothing since it rebuilds the collection.

**Stage 1 tuning.** Measured on this box (16 logical cores, 19 GB JVM heap,
459,256 functions, 0 decompile failures): 8 workers → 133 fn/s, 12 workers →
184 fn/s. Raise `--workers` until it stops helping, and keep
`PYGHIDRA_DECOMPILER_POOL` in step — the script sets it equal to `--workers`,
which matters because a worker that has to *queue* for a decompiler slot for
more than `--timeout` seconds fails that function.

**`--limit`** on `embed_gpu.py` disables resume, because a truncated run would
write a short shard under the name a full run expects.

## Files

| File | Purpose |
|---|---|
| `pyproject.toml` | deps; pins torch to PyTorch's CUDA 12.4 wheel index |
| `embed_gpu.py` | stage 2 — the GPU embedding pass (the only GPU-required script) |
| `verify_vectors.py` | checks the vectors match ChromaDB's space |
| `reference_vectors.npz` | 256 real docs + ChromaDB's own embeddings, for the check |
| `extract_functions.py` | stage 1 — runs in the container |
| `load_vectors.py` | stage 3 — runs in the container |

## Troubleshooting

**`torch.cuda.is_available()` is False.** Either the driver is missing
(`nvidia-smi`), or you got a CPU-only torch. Check with
`uv run python -c "import torch; print(torch.__version__, torch.version.cuda)"` —
it should print a `+cu124` build. If not, `uv sync --reinstall`.

**Out of GPU memory.** `--batch-size` defaults to 512; drop it to 128. The
model itself is tiny, so this only matters if something else holds the card.

**No shards written.** Every shard already existed. Pass `--force`, or check
you're pointing at the right `--out`.

**Stage 3 says ids have no matching document.** `documents.jsonl` and `vectors/`
are from different runs. Re-run stage 2 against the same JSONL.

**Search results look wrong after loading.** Re-run `verify_vectors.py`. If it
passes, the problem is the collection name or the server not having been
restarted.
