# Ghidra MCP toolchain (pyghidra-mcp)

Reverse-engineering stack for iOS/IPA work, wired into Claude Code as a project
MCP server (`.mcp.json` at the repo root).

## What runs where

| Piece | Location |
|---|---|
| uv / managed Python | `/config/xdg/bin/uv` (auto-installed) |
| Temurin JDK 21 | `/workspace/tools/jdk21` |
| Ghidra 12.1.4 | `/workspace/tools/ghidra` |
| pyghidra-mcp source | `/workspace/tools/pyghidra-mcp` (clearbluejar/pyghidra-mcp) |
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
uvx --from /workspace/tools/pyghidra-mcp pyghidra-mcp \
  --transport streamable-http \
  --project-path /workspace/ghidra-projects \
  --project-name claude-ipa \
  --program-options /workspace/Claudesk/tools/ghidra-mcp/ios-analyzer-options.json \
  /workspace/ipa-work/extracted/Payload/Claude.app/Claude
```

Server listens on `http://127.0.0.1:8000/mcp`; switch the `.mcp.json` entry to
`"type": "http"` with `"url": "http://127.0.0.1:8000/mcp"` while it runs.
Terminal client: `uvx --from /workspace/tools/pyghidra-mcp/cli pyghidra-mcp-cli`.
