import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { cp, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Browser notifications are wired across three realms: the Desktop main process
// (the wrapper relays every notification the official app shows), the bridge
// (Web Push delivery and the local notification-preferences document the
// settings panel writes), and the browser (the preload renders relayed records
// as real notifications, registers the push subscription, and the service
// worker shows pushes when no tab is open). These checks pin each of them:
//
//  - the Web Push message format against the RFC 8291 Appendix A test vector,
//    so a change in the key derivation cannot silently ship;
//  - the wrapper's capture/relay behavior, including that a notification the
//    official side suppressed is not relayed, and that a relayed click runs the
//    official handler and reports the route it navigated to;
//  - the bridge controller's preference gating, subscription bookkeeping and
//    per-browser push skip, with a real local push endpoint as the receiver;
//  - the preload's display/suppression rules and click-through navigation.

const bridgeRoot = new URL("../bridge/", import.meta.url);
const push = await import(new URL("push.mjs", bridgeRoot));
const { createNotificationController } = await import(new URL("notifications.mjs", bridgeRoot));

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

// --- Web Push format: RFC 8291 Appendix A ---------------------------------
{
  const receiverPublic = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  const authSecret = "BTBZMqHH6r4Tts7J_aSIgg";
  const senderPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  const senderPublic = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const salt = "DGv6ra1nlYgDCS1FRnbzlw";
  const expected = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
    + "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
    + "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
  const body = push.encryptPushPayload(
    { keys: { p256dh: receiverPublic, auth: authSecret } },
    "When I grow up, I want to be a watermelon",
    {
      salt: Buffer.from(salt, "base64url"),
      ephemeral: {
        privateKey: Buffer.from(senderPrivate, "base64url"),
        publicKey: Buffer.from(senderPublic, "base64url"),
      },
    },
  );
  assert.equal(base64Url(body), expected,
    "the aes128gcm record must match the RFC 8291 test vector byte for byte");
  assert.equal(body.readUInt32BE(16), 4096, "the record size must be the declared 4096");
  assert.equal(body[20], 65, "the key id must be the uncompressed sender key");

  // The VAPID token: ES256 over the JWT input, raw r||s signature, and the
  // audience must be the push endpoint's origin.
  const vapid = push.generateVapidKeys();
  const endpoint = "https://push.example.com/send/abc";
  const authorization = push.vapidAuthorization(endpoint, vapid, "mailto:ops@example.com", 1_700_000_000_000);
  const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authorization);
  assert.ok(match, `unexpected VAPID header: ${authorization}`);
  assert.equal(match[2], vapid.publicKey, "the header must carry the public key");
  const [header, claims, signature] = match[1].split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    { typ: "JWT", alg: "ES256" });
  const decodedClaims = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
  assert.equal(decodedClaims.aud, "https://push.example.com");
  assert.equal(decodedClaims.sub, "mailto:ops@example.com");
  assert.equal(decodedClaims.exp, 1_700_000_000 + 12 * 60 * 60);
  const publicKey = Buffer.from(vapid.publicKey, "base64url");
  const verified = verify("sha256", Buffer.from(`${header}.${claims}`),
    {
      key: createPublicKey({
        key: {
          kty: "EC", crv: "P-256",
          x: base64Url(publicKey.subarray(1, 33)),
          y: base64Url(publicKey.subarray(33, 65)),
        },
        format: "jwk",
      }),
      dsaEncoding: "ieee-p1363",
    },
    Buffer.from(signature, "base64url"));
  assert.equal(verified, true, "the VAPID signature must verify against its public key");

  assert.throws(() => push.parsePushSubscription({ endpoint: "http://insecure/", keys: { p256dh: receiverPublic, auth: authSecret } }),
    /https/, "a push endpoint must be an https URL");
  assert.throws(() => push.parsePushSubscription({ endpoint, keys: { p256dh: "AAAA", auth: authSecret } }),
    /P-256/, "a malformed p256dh key must be refused");
}

// --- The bridge controller: gating, subscriptions, delivery ----------------
const temporary = await mkdtemp(join(tmpdir(), "claudesk-notifications-"));
try {
  // A real push endpoint standing in for the browser's push service, with a
  // receiver keypair the smoke decrypts with.
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const authSecret = Buffer.from("0123456789abcdef");
  const receiverPublic = receiver.getPublicKey();
  const received = [];
  const endpointResponses = [];
  const pushServer = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks) });
      const status = endpointResponses.shift() ?? 201;
      response.writeHead(status);
      response.end();
    });
  });
  await new Promise((resolve) => pushServer.listen(0, "127.0.0.1", resolve));
  const pushPort = pushServer.address().port;

  function decryptPush(entry) {
    const body = entry.body;
    const salt = body.subarray(0, 16);
    const idLength = body[20];
    const senderPublic = body.subarray(21, 21 + idLength);
    const ciphertext = body.subarray(21 + idLength);
    const shared = receiver.computeSecret(senderPublic);
    const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret,
      Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]), 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt,
      Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt,
      Buffer.from("Content-Encoding: nonce\0"), 12));
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    // Node's GCM decryption wants the tag set explicitly; the record keeps it
    // as the last 16 octets of the ciphertext.
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
      decipher.final(),
    ]);
    assert.equal(plaintext.at(-1), 0x02, "the record must end with the last-record delimiter");
    return JSON.parse(plaintext.subarray(0, -1).toString("utf8"));
  }

  const pending = [];
  const deliveredClientChecks = [];
  const controller = createNotificationController({
    desktop: {
      drainNotifications: async () => pending.splice(0),
    },
    stateDir: temporary,
    hasRecentRealtimeClient: (clientId) => {
      deliveredClientChecks.push(clientId);
      return clientId === "connected-client";
    },
    log: { warn() {}, info() {} },
  });

  // The settings panel's document: every category the deployment can deliver
  // defaults on, the email-only rows report off, and reachability reads active
  // so the shell does not show its "turn push on" hint.
  const document = controller.preferencesDocument();
  assert.equal(document.preferences.feature_preference.code_requires_action.enable_push, true);
  assert.equal(document.preferences.feature_preference.bogosort.enable_push, true);
  assert.equal(document.preferences.feature_preference.completion.enable_push, true);
  assert.equal(document.push_reachability.has_active_channel, true);

  const { id } = await controller.registerSubscription({
    clientId: "phone",
    subscription: {
      endpoint: `http://127.0.0.1:${pushPort}/push`,
      keys: { p256dh: base64Url(receiverPublic), auth: base64Url(authSecret) },
    },
  });
  assert.ok(id, "the subscription must be registered");

  pending.push(
    { tag: "idle-session-1", kind: "idle", product: "ccd", title: "Fix bug", body: "Claude finished a task", sessionId: "session-1", route: "/epitaxy/session-1", at: Date.now() },
    { tag: "old", kind: "idle", product: "cowork", title: "old", body: "old", at: Date.now() - 10 * 60 * 1000 },
  );
  await controller.deliveryPass();
  assert.equal(received.length, 1, "a fresh notification must be pushed, a stale one dropped");
  const payload = decryptPush(received[0]);
  assert.equal(payload.title, "Fix bug");
  assert.equal(payload.body, "Claude finished a task");
  assert.equal(payload.route, "/epitaxy/session-1");
  assert.equal(payload.tag, "idle-session-1");
  assert.match(received[0].headers.authorization, /^vapid t=[^,]+, k=/);
  assert.equal(received[0].headers.ttl, "300");

  // A connected page renders the notification itself; its subscription must not
  // also be pushed to. The check is per subscription.
  const connected = await controller.registerSubscription({
    clientId: "connected-client",
    subscription: {
      // A distinct endpoint: subscriptions are keyed by endpoint, and this one
      // stands in for a second browser.
      endpoint: `http://127.0.0.1:${pushPort}/push-connected`,
      keys: { p256dh: base64Url(receiverPublic), auth: base64Url(authSecret) },
    },
  });
  assert.ok(connected.id);
  pending.push({ tag: "idle-session-2", kind: "idle", product: "cowork", title: "Other", body: "Waiting", at: Date.now() });
  await controller.deliveryPass();
  assert.equal(received.length, 2, "only the disconnected browser's subscription receives the push");

  // The settings toggle gates delivery; a disabled category is neither pushed
  // nor relayed to an open page (the realtime controller calls the same gate).
  await controller.applyPreferencesPatch({
    preferences: { feature_preference: { completion: { enable_push: false } } },
  });
  assert.equal(controller.preferencesDocument().preferences.feature_preference.completion.enable_push, false);
  assert.equal(controller.notificationAllowed({ kind: "idle", product: "cowork" }), false);
  assert.equal(controller.notificationAllowed({ kind: "idle", product: "ccd" }), true);
  assert.equal(controller.notificationAllowed({ kind: "permission", product: "ccd" }), true);
  assert.equal(controller.notificationAllowed({ kind: "generic", tag: "scheduled-abc" }), true);
  pending.push({ tag: "idle-session-3", kind: "idle", product: "cowork", title: "Off", body: "off", at: Date.now() });
  await controller.deliveryPass();
  assert.equal(received.length, 2, "a disabled category must not be pushed");
  await controller.applyPreferencesPatch({
    preferences: { feature_preference: { completion: { enable_push: true } } },
  });
  await assert.rejects(() => controller.applyPreferencesPatch({ preferences: {} }),
    /feature_preference/, "a malformed preference update must be refused");

  // A push service that answers 410 has forgotten the subscription; it is
  // dropped rather than retried forever.
  endpointResponses.push(410, 410, 410);
  pending.push({ tag: "gone", kind: "generic", title: "Gone", body: "x", at: Date.now() });
  await controller.deliveryPass();
  const stateAfterGone = JSON.parse(await readFile(join(temporary, "notifications.json"), "utf8"));
  assert.equal(stateAfterGone.subscriptions.length, 1, "gone subscriptions must be pruned");
  assert.equal(stateAfterGone.subscriptions[0].clientId, "connected-client",
    "the connected browser's subscription must be kept");

  // A second controller over the same directory sees the same VAPID key, so a
  // restart cannot invalidate the subscriptions browsers hold.
  const restart = createNotificationController({
    desktop: { drainNotifications: async () => [] },
    stateDir: temporary,
    hasRecentRealtimeClient: () => true,
    log: { warn() {}, info() {} },
  });
  assert.deepEqual(await restart.config(), await controller.config(),
    "the VAPID key must survive a restart");

  pushServer.close();
} finally {
  // The controller's state writes are serialized on their own chain and may
  // still be landing; retry while the directory refuses to go.
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// --- The wrapper: capture, relay, suppression, click ------------------------
const wrapperSource = await readFile(new URL("../bridge-wrapper/main.cjs", import.meta.url), "utf8");
const wrapperSection = wrapperSource.slice(
  wrapperSource.indexOf("// Desktop notifications → browser relay"),
  wrapperSource.indexOf("// --- end desktop notification relay ---"),
);
assert.ok(wrapperSection.length > 0, "the notification relay section must exist in the wrapper");

const relayed = [];
const clickResponses = [];
const clickNavigations = [];
const service = {
  activeAskUserQuestionNotifications: new Map(),
  askUserQuestionBySession: new Map(),
  shownNotificationTags: new Set(),
  responses: [],
  isLevelOff: () => false,
  showNotification(title, body, tag, onClick) {
    // Mirrors the official generic path: shown when a title exists.
    if (title) notificationShow({ title, body, tag });
    if (onClick) this.lastClick = onClick;
  },
  showIdleNotification(options) {
    if (this.suppressNextIdle) {
      this.suppressNextIdle = false;
      return;
    }
    notificationShow({
      title: options.sessionTitle || (options.product === "cowork" ? "Cowork" : "Claude Code"),
      body: options.kind === "turn_complete" ? "Claude finished a task" : "Claude is waiting for your input",
      tag: `idle-${options.sessionId}`,
    });
    if (options.onClick) this.lastIdleClick = options.onClick;
  },
  showPermissionRequestNotificationAsync: async (options) => {
    // Mirrors the official path: an await (the git repo lookup) happens before
    // the native notification is constructed.
    await new Promise((resolve) => setTimeout(resolve, 5));
    notificationShow({
      title: "repo",
      body: `Allow Claude to run ${options.description}?`,
      tag: `permission-${options.requestId}`,
    });
  },
  showAskUserQuestionNotification(options) {
    notificationShow({
      title: options.sessionTitle || "Claude Code",
      body: options.questionText || "Claude is asking you a question",
      tag: `ask-question-${options.requestId}`,
    });
  },
  getPermissionSessionRoute: (product, sessionId) => (
    product === "ccd" ? `/epitaxy/${sessionId}` : `/cowork/${sessionId}`
  ),
  focusAppAndNavigate: (route) => clickNavigations.push(`navigate:${route}`),
  handlePermissionResponse: async (product, requestId, action) => {
    service.responses.push({ product, requestId, action });
  },
  closePermissionNotification: async () => {},
  closeIdleNotificationForSession() {},
  closeNotificationIfShownThisRun() {},
  closeNotification() {},
};
function notificationShow(options) {
  // The production path: the official code constructs an Electron
  // Notification and calls show(); the wrapper's prototype patch observes it.
  wrapperSandbox.recordNativeNotificationDisplay({
    title: options.title,
    body: options.body,
  });
}
const registry = {
  dispatcher: {
    dispatchNavigate(route) {
      clickNavigations.push(route);
    },
  },
  getDispatcher() {
    return this.dispatcher;
  },
};
const wrapperSandbox = vm.createContext({
  console: { warn() {}, log() {} },
  Date,
  Math,
  encodeURIComponent,
  enqueueRelayedEvent: (event) => relayed.push(JSON.parse(JSON.stringify(event))),
  require: { cache: { "chunk.js": { exports: { Zy: service, navigation: registry } } } },
});
vm.runInContext(`${wrapperSection}\nthis.ensure=ensureNotificationRelayReady;`
  + "this.click=handleNotificationClick;this.runtime=notificationRelay;", wrapperSandbox);
assert.equal(wrapperSandbox.ensure(), true, "the service must be discovered and wrapped");
assert.equal(service.isUserViewingSession("ccd", "x"), false,
  "the host-side viewing suppression must be neutralized (nobody is at the container display)");

// A finished turn relays with the official copy, tag, kind and route.
service.showIdleNotification({
  product: "ccd", sessionId: "s1", sessionTitle: "Fix the bug", kind: "turn_complete",
  onClick: () => clickNavigations.push("idle-click"),
});
assert.equal(relayed.length, 1);
assert.deepEqual(
  { method: relayed[0].method, ...relayed[0].payload },
  {
    method: "onNotification",
    id: "idle-s1", tag: "idle-s1", title: "Fix the bug", body: "Claude finished a task",
    kind: "idle", product: "ccd", sessionId: "s1", requestId: null, allowOnce: false,
    route: "/epitaxy/s1", at: relayed[0].payload.at,
  },
);

// A notification the official side suppressed (level off, no display) must not
// be relayed: the capture is settled when the official call returns.
service.suppressNextIdle = true;
service.showIdleNotification({ product: "cowork", sessionId: "s2", kind: "needs_input" });
assert.equal(relayed.length, 1, "a suppressed notification must not be relayed");

// The permission path is asynchronous: the display record arrives after an
// await and must match its own capture by description, not the newest one.
const permissionPromise = service.showPermissionRequestNotificationAsync({
  product: "ccd", sessionId: "s3", requestId: "r1", toolName: "Bash",
  description: "npm test", allowOnceAction: true,
});
await permissionPromise;
const permission = relayed.at(-1).payload;
assert.equal(permission.tag, "permission-r1");
assert.equal(permission.kind, "permission");
assert.equal(permission.body, "Allow Claude to run npm test?");
assert.equal(permission.allowOnce, true);
assert.equal(permission.route, "/epitaxy/s3");

// Ask-question cards relay with the question as the body.
service.showAskUserQuestionNotification({
  product: "cowork", sessionId: "s4", requestId: "r2", sessionTitle: "Trip",
  questionText: "Which dates?",
});
assert.equal(relayed.at(-1).payload.body, "Which dates?");
assert.equal(relayed.at(-1).payload.tag, "ask-question-r2");

// Closers relay a close for the tag the browser notification was created with.
service.shownNotificationTags.add("idle-s1");
service.closeIdleNotificationForSession("s1");
assert.equal(relayed.at(-1).method, "onNotificationClosed");
assert.equal(relayed.at(-1).payload.tag, "idle-s1");

// A click runs the official handler and reports where it navigated.
clickNavigations.length = 0;
const clickResult = await wrapperSandbox.click("idle-s1", "default");
assert.equal(clickResult.handled, true);
assert.deepEqual(clickNavigations, ["idle-click"], "the captured official onClick must run");
assert.equal(clickResult.route, "/epitaxy/s1", "the click must report the session route");

// A permission click navigates to the session; "Allow once" and "Deny" answer
// it through the official response path instead (the same once | always | deny
// vocabulary the app's own permission cards use).
clickNavigations.length = 0;
await wrapperSandbox.click("permission-r1", "default");
assert.deepEqual(clickNavigations, ["navigate:/epitaxy/s3"]);
assert.deepEqual(clickResponses, []);
await wrapperSandbox.click("permission-r1", "allow_once");
assert.deepEqual(service.responses, [{ product: "ccd", requestId: "r1", action: "once" }],
  "Allow once must answer the permission through the official handler");
await wrapperSandbox.click("permission-r1", "deny");
assert.deepEqual(service.responses.at(-1), { product: "ccd", requestId: "r1", action: "deny" },
  "Deny must answer the permission through the official handler");

// Deny stays available on a card the official notification would not let
// allow-once (allowOnce false): refusing is always possible, answering with
// "allow once" is not — such a click falls back to opening the session.
await service.showPermissionRequestNotificationAsync({
  product: "ccd", sessionId: "s9", requestId: "r9", toolName: "Bash",
  description: "rm -rf /", allowOnceAction: false,
});
service.responses.length = 0;
clickNavigations.length = 0;
const refused = await wrapperSandbox.click("permission-r9", "allow_once");
assert.equal(refused.responded, false, "a card without allow-once must not be answered with allow once");
assert.deepEqual(clickNavigations, ["navigate:/epitaxy/s9"], "it opens the session instead");
await wrapperSandbox.click("permission-r9", "deny");
assert.deepEqual(service.responses, [{ product: "ccd", requestId: "r9", action: "deny" }],
  "deny must still answer that card");

// An unknown tag is a no-op (a click for a notification this process never
// showed), and repeated clicks are rate limited by the endpoint, not here.
assert.equal((await wrapperSandbox.click("never-seen", "default")).handled, false);

// --- The preload: display rules, click-through, status mapping --------------
const preloadSource = await readFile(new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
const displaySection = preloadSource.slice(
  preloadSource.indexOf("// BEGIN browser notifications"),
  preloadSource.indexOf("// END browser notifications"),
);
assert.ok(displaySection.length > 0, "the notification section must exist in the preload");

function loadPreload({
  permission = "granted",
  focused = false,
  pathname = "/cowork/s1",
  // When set, the harness exposes a service-worker registration, which is the
  // path an actionable (permission) card takes; `workerActive: false` models a
  // worker that never finished activating.
  serviceWorker = false,
  workerActive = true,
} = {}) {
  const created = [];
  const closed = [];
  const fetches = [];
  const navigations = [];
  const routeResponses = [];
  const workerShown = [];
  const workerClosed = [];
  let workerShowFails = false;
  const logs = [];
  const registration = {
    active: workerActive ? {} : null,
    showNotification: async (title, options) => {
      if (workerShowFails) throw new Error("service worker is not ready");
      workerShown.push({ title, options: JSON.parse(JSON.stringify(options)) });
    },
    getNotifications: async (filter) => {
      workerClosed.push(filter?.tag ?? null);
      return [{ close: () => workerClosed.push(`closed:${filter?.tag}`) }];
    },
    // A push service that rejects, like a browser without Web Push (Helium
    // ships none); the sync must log why and keep the page otherwise working.
    pushManager: {
      getSubscription: async () => null,
      subscribe: async () => { throw new Error("test browser has no push service"); },
    },
  };
  class FakeNotification {
    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.closed = false;
      created.push(this);
    }
    close() {
      this.closed = true;
      closed.push(this);
    }
  }
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = async () => permission;
  const listenerRegistry = {};
  const sandbox = vm.createContext({
    listenerRegistry,
    Notification: FakeNotification,
    document: { hasFocus: () => focused, hidden: !focused, addEventListener() {} },
    navigator: serviceWorker
      ? {
          serviceWorker: {
            addEventListener() {},
            getRegistration: async () => registration,
            register: async () => registration,
            ready: Promise.resolve(registration),
          },
        }
      : {},
    console: {
      debug: () => {},
      log: () => {},
      info: (...args) => logs.push({ level: "info", text: args.map(String).join(" ") }),
      warn: (...args) => logs.push({ level: "warn", text: args.map(String).join(" ") }),
    },
    location: { pathname, href: `https://claude.example${pathname}`, origin: "https://claude.example" },
    history: {
      state: null,
      pushState(state, _title, url) { navigations.push(url); },
    },
    localStorage: {
      getItem: () => "client-1",
      setItem() {},
    },
    PopStateEvent: class PopStateEvent { constructor(type, init) { this.type = type; this.state = init?.state; } },
    crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    Uint8Array,
    URL,
    AbortSignal,
    // The push sync gates on PushManager being exposed, as a secure-context
    // browser does.
    PushManager: class PushManager {},
    setTimeout,
    clearTimeout,
    dispatchEvent() {},
    addEventListener() {},
    focus() {},
    fetch: async (path, options = {}) => {
      fetches.push({ path, body: options.body ? JSON.parse(options.body) : null });
      if (path === "/api/remote/notifications/config") {
        // A valid uncompressed P-256 point, so notificationKeyBytes accepts it.
        return {
          json: async () => ({
            ok: true,
            value: { vapidPublicKey: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4" },
          }),
        };
      }
      return {
        json: async () => ({ ok: true, value: { route: routeResponses.shift() ?? null } }),
      };
    },
    subscribe: (surface, method, callback) => {
      listenerRegistry[`${surface}.${method}`] = callback;
      return () => {};
    },
  });
  vm.runInContext(`${displaySection}\nthis.show=showRemoteNotification;`
    + "this.closeTag=closeRemoteNotification;this.bridge=createDesktopNotificationsBridge;"
    + "this.navigate=navigateToRemoteRoute;"
    + "this.channel=listenerRegistry[\"DesktopNotifications.onNotification\"];"
    + "this.closeChannel=listenerRegistry[\"DesktopNotifications.onNotificationClosed\"];"
    + "this.notificationTags=remoteNotificationTags;", sandbox);
  return {
    sandbox, created, closed, fetches, navigations, routeResponses, FakeNotification,
    workerShown, workerClosed, logs,
    failWorkerShow: () => { workerShowFails = true; },
    channel: sandbox.channel,
    closeChannel: sandbox.closeChannel,
  };
}

// The relayed channel shows a background-tab notification with the official tag.
{
  const { sandbox, created, channel } = loadPreload();
  assert.ok(channel, "the preload must subscribe to relayed notifications itself");
  channel({ title: "Fix the bug", body: "Claude finished a task", tag: "idle-s1", sessionId: "s1", route: "/epitaxy/s1", kind: "idle", at: Date.now() });
  assert.equal(created.length, 1);
  assert.equal(created[0].title, "Fix the bug");
  const options = JSON.parse(JSON.stringify(created[0].options));
  assert.equal(options.body, "Claude finished a task");
  assert.equal(options.tag, "idle-s1");
  assert.equal(options.icon, "/desktop-icon.png",
    "the notification must wear the Claude app icon (macOS shows the app icon instead)");
  assert.equal(options.renotify, true,
    "a same-tag replacement must re-alert rather than swap silently");
  assert.equal(options.requireInteraction, undefined,
    "a finished turn may dismiss itself");

  // Permission and question cards must stay on screen until answered.
  channel({ title: "repo", body: "Allow Claude to run npm test?", tag: "permission-r1", sessionId: "s3", kind: "permission", allowOnce: true, at: Date.now() });
  assert.equal(created.at(-1).options.requireInteraction, true,
    "a permission card must not slide away unread");

  // A record older than a minute (replayed after a reconnect) must not appear.
  channel({ title: "Old", body: "x", tag: "idle-old", at: Date.now() - 61 * 1000 });
  assert.equal(created.length, 2, "stale relayed notifications must be dropped");
  // ...and a close record closes the notification with that tag.
  sandbox.closeChannel({ tag: "idle-s1" });
  assert.equal(created[0].closed, true, "a close record must close the browser notification");
  assert.equal(created[1].closed, false, "a close record must only close its own tag");
}

// While the user is looking at that very session nothing appears; a different
// session still notifies; sessionless nudges only appear in the background.
{
  const { created, channel } = loadPreload({ focused: true, pathname: "/cowork/s1" });
  channel({ title: "Same", body: "x", tag: "idle-s1", sessionId: "s1", at: Date.now() });
  assert.equal(created.length, 0, "the session being viewed must not notify");
  channel({ title: "Other", body: "x", tag: "idle-s2", sessionId: "s2", at: Date.now() });
  assert.equal(created.length, 1, "a different session must still notify");
  channel({ title: "Generic", body: "x", tag: "rate-limit_reset", at: Date.now() });
  assert.equal(created.length, 1, "a sessionless nudge must wait for the background");
}

// Without the browser permission nothing is shown, and the status mapping
// matches the strings the official renderer compares against.
{
  const { sandbox, created, channel } = loadPreload({ permission: "default" });
  channel({ title: "Denied", body: "x", tag: "idle-s1", at: Date.now() });
  assert.equal(created.length, 0, "a notification without permission must not throw or show");
  assert.equal(await sandbox.bridge().getAuthorizationStatus(), "notDetermined");
  assert.equal(await sandbox.bridge().requestAuthorization(), "error",
    "a dismissed permission prompt maps to the renderer's error result");

  const granted = loadPreload({ permission: "granted" });
  assert.equal(await granted.sandbox.bridge().getAuthorizationStatus(), "authorized");
  assert.equal(await granted.sandbox.bridge().requestAuthorization(), "granted");
  const denied = loadPreload({ permission: "denied" });
  assert.equal(await denied.sandbox.bridge().getAuthorizationStatus(), "denied");
}

// A click focuses, closes, asks the host to run its official handler and opens
// the route the answer names (falling back to the record's own route).
{
  const { sandbox, created, fetches, navigations, routeResponses } = loadPreload();
  sandbox.show({ title: "t", body: "b", tag: "idle-s9", route: "/epitaxy/s9", kind: "idle", at: Date.now() });
  routeResponses.push("/epitaxy/s9");
  created[0].onclick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(created[0].closed, true, "a click must close the notification");
  assert.deepEqual(fetches.at(-1), {
    path: "/api/remote/notifications/click",
    body: { tag: "idle-s9", action: "default" },
  });
  assert.deepEqual(navigations, ["/epitaxy/s9"], "the click must navigate to the reported route");

  const fallback = loadPreload();
  fallback.sandbox.show({ title: "t", body: "b", tag: "vm-ready", navigateTo: "/cowork/abc", at: Date.now() });
  fallback.created[0].onclick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fallback.navigations, ["/cowork/abc"],
    "without a host route the record's own target must be used");
}

// The DesktopNotifications surface the official renderer calls directly creates
// a browser notification and reports the browser's permission.
{
  const { sandbox, created } = loadPreload();
  await sandbox.bridge().showNotification("Ready to go", "Claude's all set up.", "vm-ready", "/cowork/abc", "generic", {});
  assert.equal(created.length, 1);
  assert.equal(created[0].title, "Ready to go");
}

// A permission card is actionable, and only the service worker's persistent
// notifications can carry buttons: with a registration the card goes through
// the worker (answering it from the notification, handled by the worker's click
// handler); without one it stays a plain clickable notification.
{
  const { sandbox, created, channel, workerShown, workerClosed, closeChannel, logs } = loadPreload({ serviceWorker: true });
  await channel({ title: "repo", body: "Allow Claude to run npm test?", tag: "permission-r1", sessionId: "s3", kind: "permission", allowOnce: true, route: "/epitaxy/s3", at: Date.now() });
  assert.equal(created.length, 0, "an actionable card must not use the plain constructor when a worker exists");
  assert.equal(workerShown.length, 1);
  assert.equal(workerShown[0].title, "repo");
  const card = workerShown[0].options;
  assert.deepEqual(card.actions, [
    { action: "allow_once", title: "Allow once" },
    { action: "deny", title: "Deny" },
  ]);
  assert.equal(card.requireInteraction, true);
  assert.equal(card.icon, "/desktop-icon.png");
  assert.deepEqual(card.data, {
    tag: "permission-r1", route: "/epitaxy/s3", kind: "permission", allowOnce: true,
  });

  // A finished turn stays on the plain path — only cards are actionable.
  await channel({ title: "Fix", body: "Claude finished a task", tag: "idle-s1", kind: "idle", route: "/epitaxy/s1", at: Date.now() });
  assert.equal(created.length, 1);
  assert.equal(workerShown.length, 1, "only permission cards go through the worker");

  // A close event closes a worker-shown card through getNotifications.
  closeChannel({ tag: "permission-r1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(workerClosed, ["permission-r1", "closed:permission-r1"]);

  // The harness's push service rejects like a browser without Web Push
  // (Helium): the page says so once on the console and keeps working.
  assert.ok(logs.some((entry) => entry.level === "info" && entry.text.includes("no push subscription")),
    "a browser without a push service must say why push is unavailable");

  // A worker that never activated: the card falls back, with a warning.
  const inactiveWorker = loadPreload({ serviceWorker: true, workerActive: false });
  await inactiveWorker.channel({ title: "repo", body: "Allow?", tag: "permission-r5", kind: "permission", allowOnce: true, at: Date.now() });
  assert.equal(inactiveWorker.created.length, 1, "an inactive worker must fall back to a plain notification");
  assert.ok(inactiveWorker.logs.some((entry) => entry.level === "warn" && entry.text.includes("not active")),
    "the fallback must be visible on the console");

  // Deny-only when the official notification did not offer Allow once.
  const denyOnly = loadPreload({ serviceWorker: true });
  await denyOnly.channel({ title: "repo", body: "Allow?", tag: "permission-r2", kind: "permission", allowOnce: false, at: Date.now() });
  assert.deepEqual(denyOnly.workerShown[0].options.actions, [{ action: "deny", title: "Deny" }]);

  // Without a registration (plain-HTTP origin, worker not installed) the card
  // falls back to a plain notification: still clickable, no buttons.
  const noWorker = loadPreload();
  await noWorker.channel({ title: "repo", body: "Allow?", tag: "permission-r3", kind: "permission", allowOnce: true, at: Date.now() });
  assert.equal(noWorker.created.length, 1);
  assert.equal(noWorker.created[0].options.actions, undefined);
  assert.equal(noWorker.created[0].options.requireInteraction, true);

  // A registration that rejects at show time also falls back rather than
  // dropping the notification.
  const failingWorker = loadPreload({ serviceWorker: true });
  failingWorker.failWorkerShow();
  await failingWorker.channel({ title: "repo", body: "Allow?", tag: "permission-r4", kind: "permission", allowOnce: true, at: Date.now() });
  assert.equal(failingWorker.created.length, 1, "a failing worker must fall back to a plain notification");
}

// --- The service worker -----------------------------------------------------
// The pushed path runs in a worker context the smoke otherwise never touches:
// it shows the pushed record with the app icon (and, for permission cards, the
// "Allow once" action plus requireInteraction), and on a click it asks the
// bridge which route the official handler navigated to before focusing an open
// window or opening that route.
const swSource = await readFile(new URL("../bridge/public/sw.js", import.meta.url), "utf8");

function loadServiceWorker({ windowClients = [] } = {}) {
  const handlers = new Map();
  const notifications = [];
  const requests = [];
  const opened = [];
  // The wrappers mutate the original client records, so assertions read those.
  const clients = windowClients.map((client) => ({
    focus: async () => { client.focused = true; },
    postMessage: (message) => { client.messages.push(message); },
  }));
  const sandbox = vm.createContext({
    self: {
      addEventListener: (type, handler) => handlers.set(type, handler),
      skipWaiting: async () => {},
      registration: {
        showNotification: async (title, options) => {
          notifications.push({ title, options: JSON.parse(JSON.stringify(options)) });
        },
      },
      clients: {
        claim: async () => {},
        matchAll: async () => clients,
        openWindow: async (url) => { opened.push(url); },
      },
    },
    fetch: async (path, options = {}) => {
      requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
      return { json: async () => ({ ok: true, value: { route: "/epitaxy/s1" } }) };
    },
    AbortSignal,
  });
  vm.runInContext(swSource, sandbox);
  return { handlers, notifications, requests, opened, clients };
}

function dispatchWorkerEvent(worker, type, event) {
  const waits = [];
  worker.handlers.get(type)({ ...event, waitUntil: (promise) => waits.push(promise) });
  return Promise.all(waits);
}

{
  const worker = loadServiceWorker();
  await dispatchWorkerEvent(worker, "push", {
    data: { json: () => ({ title: "Fix the bug", body: "Claude finished a task", tag: "idle-s1", kind: "idle", route: "/epitaxy/s1" }) },
  });
  const options = worker.notifications[0].options;
  assert.equal(worker.notifications[0].title, "Fix the bug");
  assert.equal(options.icon, "/desktop-icon.png", "a pushed notification must wear the app icon");
  assert.equal(options.renotify, true);
  assert.equal(options.tag, "idle-s1");
  assert.equal(options.requireInteraction, undefined, "a finished turn may dismiss itself");
  assert.equal(options.actions, undefined, "only permission cards carry actions");

  await dispatchWorkerEvent(worker, "push", {
    data: { json: () => ({ title: "repo", body: "Allow Claude to run npm test?", tag: "permission-r1", kind: "permission", allowOnce: true }) },
  });
  const permission = worker.notifications[1].options;
  assert.equal(permission.requireInteraction, true, "a permission card must not slide away unread");
  assert.deepEqual(permission.actions, [
    { action: "allow_once", title: "Allow once" },
    { action: "deny", title: "Deny" },
  ], "a permission card offers answering it straight from the notification");

  // A card whose official notification did not offer Allow once is deny-only,
  // matching the official web push's deny-only variant.
  await dispatchWorkerEvent(worker, "push", {
    data: { json: () => ({ title: "repo", body: "Allow?", tag: "permission-r2", kind: "permission", allowOnce: false }) },
  });
  assert.deepEqual(worker.notifications[2].options.actions, [{ action: "deny", title: "Deny" }]);

  // A payload without a tag still gets one: `renotify` requires it and a
  // unique tag keeps it out of any other notification's replacement slot.
  await dispatchWorkerEvent(worker, "push", {
    data: { json: () => ({ title: "No tag", body: "x", kind: "generic" }) },
  });
  const untagged = worker.notifications[3].options;
  assert.match(untagged.tag, /^claudesk-\d+-/, "an untagged push must still get a tag");
  assert.equal(untagged.data.tag, untagged.tag);

  // A click runs the bridge's official handler and opens the route it answers
  // with when no window is open...
  const clickEvent = {
    action: "",
    notification: { data: { tag: "idle-s1", route: "/epitaxy/s1" }, close() { this.closed = true; } },
  };
  await dispatchWorkerEvent(worker, "notificationclick", clickEvent);
  assert.equal(clickEvent.notification.closed, true, "a click must close the pushed notification");
  assert.deepEqual(worker.requests.at(-1), {
    path: "/api/remote/notifications/click",
    body: { tag: "idle-s1", action: "default" },
  });
  assert.deepEqual(worker.opened, ["/epitaxy/s1"], "the reported route must open");

  // ...and with an open window the worker focuses it and hands the route over
  // instead of opening a second window.
  const existingWindow = { messages: [], focused: false };
  const workerWithClient = loadServiceWorker({ windowClients: [existingWindow] });
  await dispatchWorkerEvent(workerWithClient, "notificationclick", {
    action: "",
    notification: { data: { tag: "idle-s1", route: "/epitaxy/s1" }, close() {} },
  });
  assert.deepEqual(workerWithClient.opened, []);
  assert.equal(existingWindow.focused, true, "an existing window must be focused");
  assert.deepEqual(JSON.parse(JSON.stringify(existingWindow.messages)),
    [{ type: "claudesk-notification-navigate", route: "/epitaxy/s1" }]);

  // "Allow once" answers the permission and must not steal focus or navigate.
  const allowOnce = { action: "allow_once", notification: { data: { tag: "permission-r1", kind: "permission", allowOnce: true }, close() {} } };
  await dispatchWorkerEvent(worker, "notificationclick", allowOnce);
  assert.deepEqual(worker.requests.at(-1), {
    path: "/api/remote/notifications/click",
    body: { tag: "permission-r1", action: "allow_once" },
  });
  assert.equal(worker.opened.length, 1, "answering a permission must not open a window");

  // ...and so does "Deny", which must reach the same official response path.
  const deny = { action: "deny", notification: { data: { tag: "permission-r1", kind: "permission", allowOnce: true }, close() {} } };
  await dispatchWorkerEvent(worker, "notificationclick", deny);
  assert.deepEqual(worker.requests.at(-1), {
    path: "/api/remote/notifications/click",
    body: { tag: "permission-r1", action: "deny" },
  });
  assert.equal(worker.opened.length, 1, "denying must not open a window");
}

// --- The bridge's HTTP surface ----------------------------------------------
// The notification-preferences routes stand in for claude.ai's API, which the
// app fetches directly: they must answer with the document itself, not the
// bridge's `{ok, value}` envelope — the app parses the body as the document, so
// an envelope made the settings panel read `data.preferences` off it and crash
// ("Cannot read properties of undefined (reading 'feature_preference')"). The
// push routes are this bridge's own API and keep the envelope. Both contracts
// are exercised over real HTTP against the actual server module, staged the way
// the image copies it (modules beside release.json) with a fake Desktop behind.
{
  const base = await mkdtemp(join(tmpdir(), "claudesk-bridge-stage-"));
  const stage = join(base, "app");
  const stateDir = join(base, "state");
  const fakeDesktop = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      value: request.url?.startsWith("/health") ? {} : [],
    }));
  });
  await new Promise((resolve) => fakeDesktop.listen(0, "127.0.0.1", resolve));
  const desktopPort = fakeDesktop.address().port;
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const bridgePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  await cp(fileURLToPath(new URL("../bridge", import.meta.url)), stage, { recursive: true });
  await copyFile(
    fileURLToPath(new URL("../config/release.json", import.meta.url)),
    join(stage, "release.json"),
  );

  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: stage,
    env: {
      ...process.env,
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: String(bridgePort),
      COWORK_INTERNAL_URL: `http://127.0.0.1:${desktopPort}`,
      COWORK_BRIDGE_STATE_DIR: stateDir,
      COWORK_INTERNAL_FAILURE_EXIT_THRESHOLD: "99",
      CLAUDE_INFERENCE_MODELS_JSON: "[]",
      CLAUDE_REMOTE_WEB_SHELL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bridgeLog = [];
  child.stdout.on("data", (chunk) => bridgeLog.push(String(chunk)));
  child.stderr.on("data", (chunk) => bridgeLog.push(String(chunk)));
  try {
    const origin = `http://127.0.0.1:${bridgePort}`;
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      try {
        ready = (await fetch(`${origin}/api/remote/notifications/config`)).ok;
      } catch {}
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, `the bridge did not start:\n${bridgeLog.join("")}`);

    const organization = "00000000-0000-4000-8000-000000000001";
    const preferencesUrl = `${origin}/api/organizations/${organization}/notification/preferences`;

    const document = await fetch(preferencesUrl).then((response) => response.json());
    assert.equal(document.value, undefined,
      "the preferences route must not wrap the document in the bridge envelope");
    assert.ok(document.preferences?.feature_preference,
      "the app reads data.preferences.feature_preference directly");
    assert.equal(document.preferences.feature_preference.completion.enable_push, true);
    assert.equal(document.push_reachability.has_active_channel, true);

    const patched = await fetch(preferencesUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preferences: { feature_preference: { completion: { enable_push: false } } },
      }),
    }).then((response) => response.json());
    assert.equal(patched.preferences.feature_preference.completion.enable_push, false,
      "the PATCH answer must carry the updated document itself");
    const reread = await fetch(preferencesUrl).then((response) => response.json());
    assert.equal(reread.preferences.feature_preference.completion.enable_push, false,
      "the changed preference must persist across requests");

    const channel = await fetch(
      `${origin}/api/organizations/${organization}/notification/channels`,
      { method: "POST" },
    ).then((response) => response.json());
    assert.deepEqual(channel, { channel_type: "FCM", client_platform: "web", status: "ACTIVE" },
      "the channel registration answer is a raw document as well");

    const pushConfig = await fetch(`${origin}/api/remote/notifications/config`)
      .then((response) => response.json());
    assert.equal(typeof pushConfig.value?.vapidPublicKey, "string",
      "the bridge's own push routes keep the {ok, value} envelope");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    fakeDesktop.close();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

console.log("notifications-smoke: push format, relay capture, gating and browser display passed");
