#!/usr/bin/env python3
"""Stage 1: decompile every function in the Ghidra project to documents.jsonl.

This runs *where the Ghidra project lives* (the analysis container), not on the
GPU box -- decompilation needs the 3.7 GB analyzed project, and the whole point
of the GPU package is to avoid shipping or re-analyzing it.

Writes one JSON object per line:

    {"id": "...", "document": "<pseudo-C>", "function_name": "...", "entry_point": "..."}

``id`` and the metadata are exactly what pyghidra-mcp's own indexer produces
(``<symbol name, 50 chars max>-<entry point>``), so load_vectors.py can put the
GPU-computed vectors into the collection the MCP server reads.

Safe to interrupt: ids already present in the output file are skipped on the
next run (works however the parallel decompiles happened to complete, because
progress is tracked by id, not by position).

    uv run extract_functions.py --out documents.jsonl
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import sys
import threading
import time
from pathlib import Path

DEFAULT_PROJECT_PATH = "/workspace/ghidra-projects"
DEFAULT_PROJECT_NAME = "claude-ipa"
DEFAULT_MCP_DIR = "/workspace/tools/pyghidra-mcp"
DEFAULT_GHIDRA_DIR = "/workspace/tools/ghidra"
DEFAULT_JAVA_HOME = "/workspace/tools/jdk21"


def prepare_env() -> None:
    """pyghidra reads these from the environment; mirror .mcp.json's block."""
    os.environ.setdefault("GHIDRA_INSTALL_DIR", DEFAULT_GHIDRA_DIR)
    os.environ.setdefault("JAVA_HOME", DEFAULT_JAVA_HOME)
    os.environ.setdefault("JAVA_HOME_OVERRIDE", os.environ["JAVA_HOME"])
    java_bin = str(Path(os.environ["JAVA_HOME"]) / "bin")
    os.environ["PATH"] = java_bin + os.pathsep + os.environ.get("PATH", "")


def function_id(func) -> str:
    """Reproduce GhidraTools._get_filename -- the id used as the Chroma key."""
    name = func.getSymbol().getName(True)[:50]
    return f"{name}-{func.getEntryPoint()}"


def load_done_ids(path: Path) -> set[str]:
    """Ids already written, tolerating a torn final line from a hard kill."""
    if not path.is_file():
        return set()
    done: set[str] = set()
    with path.open("rb") as fh:
        data = fh.read()
    if data and not data.endswith(b"\n"):
        # Drop the partial record so the next append starts on a clean line.
        data = data[: data.rfind(b"\n") + 1] if b"\n" in data else b""
        path.write_bytes(data)
        print(f"  truncated a partial trailing record in {path.name}")
    for line in data.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "id" in obj:
            done.add(obj["id"])
    return done


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", type=Path, default=Path("documents.jsonl"))
    ap.add_argument("--project-path", default=DEFAULT_PROJECT_PATH)
    ap.add_argument("--project-name", default=DEFAULT_PROJECT_NAME)
    ap.add_argument("--pyghidra-mcp-dir", default=DEFAULT_MCP_DIR)
    ap.add_argument("--binary", default=None, help="only this program (substring match)")
    ap.add_argument("--workers", type=int, default=8, help="parallel decompiles (default: 8)")
    ap.add_argument("--timeout", type=int, default=30, help="per-function decompile timeout, seconds")
    ap.add_argument("--limit", type=int, default=0, help="stop after N functions (smoke test)")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    prepare_env()

    # The decompiler pool is built when the context is created, so this has to
    # be set before importing/instantiating anything that touches it.
    os.environ["PYGHIDRA_DECOMPILER_POOL"] = str(args.workers)

    import pyghidra

    pyghidra.start(False)

    from pyghidra_mcp.context import PyGhidraContext
    from pyghidra_mcp.tools import GhidraTools

    print(f"opening project {args.project_name} at {args.project_path} ...")
    ctx = PyGhidraContext(
        project_name=args.project_name,
        project_path=args.project_path,
        pyghidra_mcp_dir=Path(args.pyghidra_mcp_dir),
        threaded=True,
        wait_for_analysis=False,
    )

    done = load_done_ids(args.out)
    if done:
        print(f"resuming: {len(done):,} functions already in {args.out.name}")

    written = 0
    failed = 0
    lock = threading.Lock()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out = args.out.open("a", encoding="utf-8", buffering=1 << 20)

    def work(tools, func):
        nonlocal written, failed
        try:
            decompiled = tools.decompile_function(func, timeout=args.timeout)
        except Exception as exc:  # noqa: BLE001 - one bad function must not stop the run
            with lock:
                failed += 1
                if failed <= 20:
                    print(f"  ! {function_id(func)}: {exc}", file=sys.stderr)
            return
        record = {
            "id": decompiled.name,
            "document": decompiled.code,
            "function_name": decompiled.name,
            "entry_point": str(func.getEntryPoint()),
        }
        line = json.dumps(record, ensure_ascii=False)
        with lock:
            out.write(line + "\n")
            written += 1
            if written % 5000 == 0:
                out.flush()
                print(f"  {written:,} written ({failed:,} failed)", flush=True)

    programs = [
        (name, info)
        for name, info in ctx.programs.items()
        if not args.binary or args.binary in name
    ]
    if not programs:
        print(f"error: no program matching {args.binary!r} in project", file=sys.stderr)
        return 2

    started = time.time()
    try:
        for name, info in programs:
            tools = GhidraTools(info)
            funcs = tools.get_all_functions()
            # Deterministic order so a resumed run's skip set lines up.
            funcs.sort(key=lambda f: f.getEntryPoint().getOffset())
            pending = [f for f in funcs if function_id(f) not in done]
            print(f"{name}: {len(funcs):,} functions, {len(pending):,} to do")

            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
                futures = []
                for func in pending:
                    if args.limit and len(futures) >= args.limit:
                        break
                    futures.append(pool.submit(work, tools, func))
                for fut in concurrent.futures.as_completed(futures):
                    fut.result()
    finally:
        out.flush()
        out.close()

    elapsed = time.time() - started
    print(
        f"\ndone: {written:,} written, {failed:,} failed in {elapsed:,.1f}s "
        f"({written / max(elapsed, 1e-9):,.0f} fn/s) -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
