"use strict";

require("./main.cjs");
const { claudeCoworkBridgeOriginalMain } = require("../package.json");
if (claudeCoworkBridgeOriginalMain !== ".vite/build/index.pre.js") {
  throw new Error("unsupported official Desktop entry point");
}
require(`../${claudeCoworkBridgeOriginalMain}`);
