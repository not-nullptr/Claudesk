// One slice of the renderer analysis, on its own thread.
//
// The preparer hands every worker a list of chunk paths and the two flags;
// each worker reads its own chunks and returns the per-file analysis. Reading
// here rather than shipping the sources through `workerData` keeps
// structured-clone to the small result — the splices and marker evidence — and
// not the ~25 MB of minified text behind them.
//
// The work is exactly `inspectRenderer` per file, which is why this can be
// parallel at all: the union, the required-patch invariants and the splicing
// all happen afterwards in `assembleRenderer`, single-threaded and unchanged.
import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

import { inspectRenderer } from "./renderer-patches.mjs";

const { paths, gatewayEnabled, webShellEnabled } = workerData;

const analyses = [];
for (const path of paths) {
  analyses.push([path, inspectRenderer(await readFile(path, "utf8"), gatewayEnabled, webShellEnabled)]);
}

parentPort.postMessage(analyses);
