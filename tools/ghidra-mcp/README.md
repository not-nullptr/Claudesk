# Ghidra MCP toolchain (pyghidra-mcp)

Reverse-engineering stack for iOS/IPA work, wired into Claude Code as a project
MCP server (`.mcp.json` at the repo root).

## What runs where

| Piece | Location |
|---|---|
| uv / managed Python | `/config/xdg/bin/uv` (auto-installed) |
| Temurin JDK 21 | `/workspace/tools/jdk21` |
| Ghidra 12.1.4 | `/workspace/tools/ghidra` |
| pyghidra-mcp source | `/workspace/tools/pyghidra-mcp` (clearbluejar/pyghidra-mcp, pinned) |
| pyghidra-mcp server | `/workspace/tools/pyghidra-mcp/.venv/bin/pyghidra-mcp` (editable install) |
| Ghidra projects | `/workspace/ghidra-projects/claude-ipa.gpr` |
| Analyzer options (Swift/ObjC/DWARF/ParamID) | `tools/ghidra-mcp/ios-analyzer-options.json` |

Heavy artifacts stay in `/workspace` (persistent volume) — the repo only holds
this config. After a container rebuild, run
`tools/ghidra-mcp/setup-ghidra.sh` once to restore `/workspace/tools`, then
restart the session so Claude Code picks up `.mcp.json` (approve the server
when prompted).

## Gotchas

- `/etc/passwd` gives user `app` the home `/dev/null` (base image default). The
  JDK takes `user.home` from passwd, not `$HOME`, so Ghidra's LaunchSupport
  crashes until `support/launch.properties` pins
  `VMARGS_LINUX=-Duser.home=/config` (setup script appends it) and
  `JAVA_HOME_OVERRIDE` is set so pyghidra skips LaunchSupport entirely.
- Ghidra can use a native `swift-demangle` binary when `GHIDRA_SWIFT_DEMANGLER`
  is set (see launch.properties); the built-in Java demangler covers Swift 5
  mangling for most cases. Optional add if demangling comes up short.
- **Never launch the server with `uvx --from <dir>`.** uv builds a cached copy
  of the local package and does **not** rebuild it when the source changes, so
  after applying a patch the server silently keeps running the *previous* code
  (this cost a multi-hour index run that wrote nothing). `uvx` also refuses
  `--reinstall-package`. The installer therefore makes an editable install and
  `.mcp.json` runs `.venv/bin/pyghidra-mcp` directly. (To force a uvx refresh
  anyway: `uv cache prune`.)
- **JVM heap must be sized to the container, not the host.** Ghidra sizes
  nothing for you, and a hand-edited `-Xmx16G` (host RAM) on a 3 GiB cgroup
  makes the JVM never collect until it is past `memory.max`, then GC-thrash and
  get OOM-killed mid-index. `setup-ghidra.sh` now rewrites `VMARGS=-Xmx…` in
  `support/launch.properties` to 60% of `/sys/fs/cgroup/memory.max` on every
  run, so re-running the script also repairs a poisoned value. Verify with
  `grep '^VMARGS=' /workspace/tools/ghidra/support/launch.properties` and
  `cat /sys/fs/cgroup/memory.max`.

## Vendored patches

The clone at `/workspace/tools/pyghidra-mcp` is pinned to a specific upstream
commit and carries local patches (`patches/*.patch`, applied by
`setup-ghidra.sh`). The MCP server must run from the venv the installer builds
(`.venv/bin/pyghidra-mcp`, an editable install) — see the uvx gotcha above;
running it via `uvx --from <dir>` serves a stale cached build.

`patches/0001-stream-and-parallelize-index.patch`:

- streams decompiled function bodies to Chroma in batches instead of holding
  every body in RAM until the end (peak RSS then scales with the batch, not the
  binary — this is what makes a 523k-function Mach-O indexable in a small
  container), and
- decompiles across a bounded thread pool.

Both knobs are read from the environment and default to the old behaviour:

| Env var | Default | Meaning |
|---|---|---|
| `PYGHIDRA_INDEX_WORKERS` | 1 | parallel decompile threads feeding Chroma |
| `PYGHIDRA_INDEX_BATCH` | 256 | functions buffered before a Chroma write |
| `PYGHIDRA_DECOMPILER_POOL` | 2 | decompiler slots (raise with workers) |

`PYGHIDRA_DECOMPILER_POOL` caps how many decompiles run at once, so
`PYGHIDRA_INDEX_WORKERS` above it only queues. Raise both together, and watch
`/sys/fs/cgroup/memory.stat` `anon` against `memory.max` — the JVM program image
plus decompiler state is the large fixed cost, not the batch.

## GPU embedding pass (`gpu-embed/`)

The in-process indexer above is **embedding-bound, not decompile-bound**:
ChromaDB's default embedder (all-MiniLM-L6-v2 via CPU-only onnxruntime) runs at
~30 docs/s, so the 459k-function Claude binary takes ~5 hours to index even with
the parallel patch. `gpu-embed/` sidesteps that by running the embedding on an
external CUDA GPU: stage 1 decompiles here to `documents.jsonl` (~42 min at
`--workers 12`), stage 2 embeds on the GPU box, stage 3 loads the vectors back
into ChromaDB with every embedding passed explicitly, so Chroma's CPU embedder is
never called. The vectors are bit-compatible with the query side (all-MiniLM-L6-v2,
mean-pooled, L2-normalised, 256-token truncation — `verify_vectors.py` checks this
against embeddings ChromaDB itself produced).

See `gpu-embed/README.md`. A ready-to-ship copy is zipped at `/workspace/gpu-embed.zip`.

## iOS setup notes

- Target: `/workspace/ipa-work/extracted/Payload/Claude.app/Claude` (thin arm64
  Mach-O, ~97 MB). The server imports and analyzes it asynchronously on first
  start; analysis state persists in the `claude-ipa` project.
- `ios-analyzer-options.json` forces the Swift demangler, Objective-C 2.0
  analyzers, DWARF processing, and Decompiler Parameter ID (better Swift/ObjC
  signatures, at the cost of slower first analysis).
- More binaries from the `.app` (framework dylibs, extensions) can be pulled in
  later with the `import_binary` MCP tool — it accepts a directory and imports
  recursively.

## Shared-server mode (optional)

stdio is the default in `.mcp.json` (Claude Code spawns it per session —
nothing to babysit). To share one JVM/analysis across sessions and use
`pyghidra-mcp-cli` instead, start the HTTP flavor manually:

```bash
GHIDRA_INSTALL_DIR=/workspace/tools/ghidra JAVA_HOME=/workspace/tools/jdk21 \
PATH=/workspace/tools/jdk21/bin:$PATH \
/workspace/tools/pyghidra-mcp/.venv/bin/pyghidra-mcp \
  --transport streamable-http \
  --project-path /workspace/ghidra-projects \
  --project-name claude-ipa \
  --program-options /workspace/Claudesk/tools/ghidra-mcp/ios-analyzer-options.json \
  /workspace/ipa-work/extracted/Payload/Claude.app/Claude
```

Server listens on `http://127.0.0.1:8000/mcp`; switch the `.mcp.json` entry to
`"type": "http"` with `"url": "http://127.0.0.1:8000/mcp"` while it runs.
Terminal client: `uvx --from /workspace/tools/pyghidra-mcp/cli pyghidra-mcp-cli`.
