import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The corrected config-health probe is a real inference request: a rate-limited
// canonical route makes the bridge look for another seeded model that answers.
// It runs from the settings surface on every page load, so it must find *one*
// route and stop — not fan out over the whole model list. This boots the bridge
// against a mock Desktop (which reports the rejected model) and a mock gateway
// (which rate limits the canonical route and answers the first alternate), and
// counts what reached the gateway.
const root = fileURLToPath(new URL("..", import.meta.url));
const server = `${root}bridge/server.mjs`;
const releaseFile = `${root}bridge/release.json`;

const createdRelease = !existsSync(releaseFile);
if (createdRelease) writeFileSync(releaseFile, readFileSync(`${root}config/release.json`));

const stateDir = mkdtempSync(join(tmpdir(), "health-probe-"));
const children = [];
const servers = [];

function listen(handler) {
  return new Promise((resolve) => {
    const mock = http.createServer(handler);
    servers.push(mock);
    mock.listen(0, "127.0.0.1", () => resolve(mock));
  });
}

async function boot({ port, env }) {
  const started = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_HOST: "127.0.0.1",
      COWORK_BRIDGE_STATE_DIR: stateDir,
      AUTH_IDENTITY_URL: "http://127.0.0.1:9",
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(started);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the bridge did not start")), 10000);
    started.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    started.on("exit", (code) => reject(new Error(`the bridge exited with ${code}`)));
  });
  return async (path, init) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, body: await response.text() };
  };
}

try {
  // Every inference request the bridge makes, in order. `canonical` is the
  // route the mock Desktop's health doc names; only its provider-prefixed
  // spelling exists on the mock gateway, so the bridge resolves the alias and
  // probes it first.
  const canonical = "anthropic/claude-opus-5-5";
  const fallback = "fable-cheap";
  const probes = [];
  const gateway = await listen((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "GET" && request.url.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          data: [
            { id: "claude-opus-5-5" },
            { id: canonical },
            { id: fallback },
            { id: "claude-haiku-5-5" },
            { id: "other-route-1" },
            { id: "other-route-2" },
            { id: "other-route-3" },
            { id: "other-route-4" },
            { id: "other-route-5" },
          ],
          has_more: false,
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/messages") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        probes.push(body.model);
        if (body.model === canonical) {
          response.writeHead(429, { "content-type": "application/json" });
          response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          type: "message", role: "assistant", model: body.model,
          content: [{ type: "text", text: "." }], stop_reason: "max_tokens",
        }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  const gatewayPort = gateway.address().port;

  // The mock Desktop's settings surface: the only thing this smoke asks of it
  // is config health, whose rejection is what starts the probe.
  let healthCalls = 0;
  const desktop = await listen((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (request.url === "/settings-invoke"
        && body.surface === "Custom3pSetup" && body.method === "getConfigHealth") {
        healthCalls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          value: {
            state: "config_model_rejected",
            source: "deployment",
            provider: "gateway",
            checkedAt: new Date().toISOString(),
            httpStatus: 404,
            probedModel: "claude-opus-5-5",
          },
        }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, value: null, surfaces: {} }));
    });
  });
  const desktopPort = desktop.address().port;

  const port = 8161;
  const request = await boot({
    port,
    env: {
      COWORK_INTERNAL_URL: `http://127.0.0.1:${desktopPort}`,
      CLAUDE_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
      CLAUDE_GATEWAY_API_KEY: "smoke-gateway-key",
      CLAUDE_GATEWAY_AUTH_SCHEME: "bearer",
      CLAUDE_REMOTE_GATEWAY_SETTINGS: "1",
    },
  });
  const health = async () => JSON.parse((await request("/api/remote/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface: "Custom3pSetup", method: "getConfigHealth", args: [] }),
  })).body);

  const first = await health();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.state, "healthy",
    "one alternate route answering clears the false rejection");
  assert.equal(first.value.probedModel, fallback);
  assert.deepEqual(probes, [canonical, fallback],
    "the canonical route is probed, then exactly one alternate — not the whole list");

  // The probe answers are cached briefly, so a reload does not ask again.
  const second = await health();
  assert.equal(second.value.state, "healthy");
  assert.deepEqual(probes, [canonical, fallback],
    "a second page load inside the cache answers without another inference request");
  assert.equal(healthCalls, 2, "the Desktop's health is still read each time");

  console.log("health-probe-smoke: one alternate route, no model fan-out");
} finally {
  for (const child of children) child.kill("SIGTERM");
  for (const mock of servers) mock.close();
  if (createdRelease) rmSync(releaseFile, { force: true });
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
