// Browser notification support for the remote UI.
//
// The wrapper in the Desktop container relays every notification the official
// app decides to show (turn finished, needs input, tool permission, ask
// question, and the renderer-driven ones) as `DesktopNotifications` events.
// The remote preload renders them in an open tab; this controller covers the
// rest:
//
//  - it polls the wrapper's dedicated notification queue (which, unlike the
//    event relay, is drained even when no tab is connected) and forwards each
//    notification to the browser push subscriptions that were registered for
//    this deployment, so notifications still arrive with every tab closed;
//  - it answers the renderer's notification-preferences API
//    (`/api/organizations/{org}/notification/preferences` and the channel
//    registration route) locally. The official bundle talks to claude.ai's
//    server-side push preferences there — this deployment has no such backend,
//    and the settings panel's toggles must persist somewhere for the enabled
//    categories to gate what is delivered;
//  - it stores subscriptions and VAPID keys under the bridge state directory
//    so a container restart does not silently unsubscribe every browser.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateVapidKeys, parsePushSubscription, sendPushNotification } from "./push.mjs";

const stateFileName = "notifications.json";
const maxSubscriptions = 32;
const notificationMaxAgeMs = 90 * 1000;
const pollIntervalMs = 1500;

// Feature keys the official web settings write (`preferences.feature_preference.
// <key>.enable_push`). Defaults are on for the categories a self-hosted
// deployment can actually deliver — the desktop app notifies by default, and
// every toggle in the settings panel can then turn one off. `enable_email` is
// reported off because nothing sends mail.
const featureDefaults = {
  completion: { enable_push: true, enable_email: false },
  compass: { enable_push: true, enable_email: false },
  code_requires_action: { enable_push: true, enable_email: false },
  bogosort: { enable_push: true, enable_email: false },
  routines: { enable_push: true, enable_email: false },
  dispatch: { enable_push: false, enable_email: false },
  code_security_scan: { enable_push: false, enable_email: false },
  admin_spend_alerts: { enable_email: false },
};

function clampString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

// Which preference gates a relayed notification. Permission/ask cards are the
// "Code permission requests" category for Code sessions; idle notifications are
// "Code notifications" for Code and "Response completions" for chat/Cowork;
// scheduled-task runs have their own row. Anything else is not gated.
export function notificationCategoryKey(payload) {
  const kind = payload?.kind;
  const product = payload?.product;
  if (kind === "permission" || kind === "ask") {
    return product === "ccd" ? "code_requires_action" : null;
  }
  if (kind === "idle") {
    return product === "ccd" ? "bogosort" : "completion";
  }
  if (typeof payload?.tag === "string" && payload.tag.startsWith("scheduled-")) {
    return "routines";
  }
  return null;
}

export function createNotificationController({
  desktop,
  stateDir,
  hasRecentRealtimeClient,
  log = console,
  pushSubject = "mailto:claudesk@localhost",
}) {
  const state = {
    vapid: null,
    subscriptions: [],
    featurePreference: {},
  };
  let persistChain = Promise.resolve();
  // Set when a lazily generated VAPID key still needs its write; `config()`
  // awaits it so the key handed to a browser is already durable.
  let persistPending = null;
  let pollInFlight = false;
  let poller = null;

  const statePath = join(stateDir, stateFileName);

  async function loadState() {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      const vapid = parsed?.vapid;
      if (vapid && typeof vapid.publicKey === "string" && typeof vapid.privateKey === "string") {
        state.vapid = { publicKey: vapid.publicKey, privateKey: vapid.privateKey };
      }
      if (Array.isArray(parsed?.subscriptions)) {
        state.subscriptions = parsed.subscriptions
          .map((entry) => {
            try {
              const subscription = parsePushSubscription(entry);
              if (typeof entry?.clientId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(entry.clientId)) {
                subscription.clientId = entry.clientId;
              }
              if (Number.isFinite(entry?.addedAt)) subscription.addedAt = entry.addedAt;
              return subscription;
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .slice(0, maxSubscriptions);
      }
      if (parsed?.featurePreference && typeof parsed.featurePreference === "object") {
        state.featurePreference = parsed.featurePreference;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        log.warn(`[cowork-bridge] notification state could not be read: ${error.message}`);
      }
    }
  }

  // Reads and writes must wait for the stored state to load, or a request that
  // arrives during startup would persist over it with an empty document.
  const ready = loadState();

  function persistState() {
    // Serialize writes; a failed write must not reject the caller (the request
    // that triggered it has already succeeded from the browser's point of view).
    persistChain = persistChain.then(async () => {
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, statePath);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        log.warn(`[cowork-bridge] notification state could not be saved: ${error.message}`);
      }
    });
    return persistChain;
  }

  function ensureVapidKeys() {
    if (!state.vapid) {
      state.vapid = generateVapidKeys();
      // The key must be durable before it is handed out: a subscription is
      // bound to it, and a key that vanished on restart would orphan every
      // browser that subscribed meanwhile.
      persistPending = persistState();
    }
    return state.vapid;
  }

  // The document the renderer's notification settings read and write. It has
  // the same shape the claude.ai backend serves: `preferences.feature_preference`
  // (per-feature enable_push/enable_email), `effective_preferences` and
  // `push_reachability`. `code_security_scan` and `admin_spend_alerts` are
  // email-only features here, so their rows render but stay inert.
  function preferencesDocument() {
    const featurePreference = {};
    for (const [key, defaults] of Object.entries(featureDefaults)) {
      const stored = state.featurePreference[key];
      featurePreference[key] = stored && typeof stored === "object" && !Array.isArray(stored)
        ? { ...defaults, ...stored }
        : { ...defaults };
    }
    const preferences = { feature_preference: featurePreference };
    return {
      preferences,
      effective_preferences: JSON.parse(JSON.stringify(featurePreference)),
      push_reachability: {
        has_active_channel: true,
        most_recent_token_refresh: null,
        platforms: [],
      },
      admin_spend_alerts_available: false,
    };
  }

  async function applyPreferencesPatch(body) {
    await ready;
    const patch = body?.preferences?.feature_preference;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("notification preferences update must carry feature_preference");
    }
    const entries = Object.entries(patch);
    if (!entries.length || entries.length > 32) {
      throw new Error("notification preferences update has an invalid number of fields");
    }
    for (const [key, value] of entries) {
      if (!(key in featureDefaults)) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`notification preference ${key} must be an object`);
      }
      const stored = state.featurePreference[key] ?? {};
      for (const [field, item] of Object.entries(value)) {
        if (field !== "enable_push" && field !== "enable_email") continue;
        if (typeof item !== "boolean") {
          throw new Error(`notification preference ${key}.${field} must be a boolean`);
        }
        stored[field] = item;
      }
      state.featurePreference[key] = stored;
    }
    await persistState();
    return preferencesDocument();
  }

  function categoryEnabled(key) {
    if (!key) return true;
    const stored = state.featurePreference[key];
    if (stored && typeof stored === "object" && stored.enable_push === false) return false;
    return true;
  }

  function notificationAllowed(payload) {
    return categoryEnabled(notificationCategoryKey(payload));
  }

  function subscriptionId(endpoint) {
    return createHash("sha256").update(endpoint).digest("base64url").slice(0, 16);
  }

  async function registerSubscription(value) {
    await ready;
    const subscription = parsePushSubscription(value?.subscription ?? value);
    // The page that created the subscription identifies itself so a push can be
    // skipped while that very browser is connected (its page shows the
    // notification itself).
    const clientId = typeof value?.clientId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value.clientId)
      ? value.clientId
      : "";
    ensureVapidKeys();
    const id = subscriptionId(subscription.endpoint);
    const existing = state.subscriptions.find((entry) => subscriptionId(entry.endpoint) === id);
    if (existing) {
      Object.assign(existing, subscription);
      if (clientId) existing.clientId = clientId;
    } else {
      if (state.subscriptions.length >= maxSubscriptions) {
        state.subscriptions = state.subscriptions.slice(1);
      }
      state.subscriptions.push({ ...subscription, clientId: clientId || null, addedAt: Date.now() });
    }
    await persistState();
    return { id };
  }

  async function removeSubscription(value) {
    await ready;
    const endpoint = clampString(value?.endpoint, 2000);
    if (!endpoint) throw new Error("push subscription endpoint is required");
    const id = subscriptionId(endpoint);
    const before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter((entry) => subscriptionId(entry.endpoint) !== id);
    if (state.subscriptions.length !== before) await persistState();
    return { removed: before - state.subscriptions.length };
  }

  async function deliveryPass() {
    if (pollInFlight) return;
    pollInFlight = true;
    await ready;
    try {
      const notifications = await desktop.drainNotifications();
      if (!notifications.length) return;
      const fresh = notifications.filter((payload) => (
        payload && typeof payload === "object"
        && Date.now() - (Number(payload.at) || 0) <= notificationMaxAgeMs
        && notificationAllowed(payload)
      ));
      if (!fresh.length) return;
      // A page that is connected renders these itself over its event stream;
      // pushing to that same browser would show each notification twice. The
      // check is per subscription: other browsers (a phone, a second desktop)
      // still receive the push.
      const eligible = state.subscriptions.filter((subscription) => (
        !hasRecentRealtimeClient(subscription.clientId)
      ));
      if (!eligible.length) return;
      const vapid = ensureVapidKeys();
      for (const payload of fresh) {
        const gone = [];
        await Promise.all(eligible.map(async (subscription) => {
          try {
            const result = await sendPushNotification(subscription, {
              title: clampString(payload.title, 200),
              body: clampString(payload.body, 400),
              tag: clampString(payload.tag, 200),
              kind: clampString(payload.kind, 32),
              route: clampString(payload.route, 500) || null,
              sessionId: clampString(payload.sessionId, 200) || null,
              allowOnce: payload.allowOnce === true,
              at: Number(payload.at) || Date.now(),
            }, { vapid, subject: pushSubject });
            if (result.gone) gone.push(subscription);
          } catch (error) {
            log.warn(`[cowork-bridge] web push delivery failed: ${error.message}`);
          }
        }));
        if (gone.length) {
          state.subscriptions = state.subscriptions.filter((entry) => !gone.includes(entry));
          await persistState();
        }
      }
    } catch (error) {
      // The internal bridge may not be up yet; the next tick retries.
      log.warn(`[cowork-bridge] notification delivery pass failed: ${error.message}`);
    } finally {
      pollInFlight = false;
    }
  }

  function start() {
    poller = setInterval(() => void deliveryPass(), pollIntervalMs);
    poller.unref?.();
  }

  function stop() {
    if (poller) clearInterval(poller);
    poller = null;
  }

  return {
    applyPreferencesPatch,
    config: async () => {
      await ready;
      const vapid = ensureVapidKeys();
      if (persistPending) await persistPending.catch(() => {});
      return { vapidPublicKey: vapid.publicKey };
    },
    deliveryPass,
    notificationAllowed,
    preferencesDocument,
    registerSubscription,
    removeSubscription,
    start,
    stop,
  };
}
