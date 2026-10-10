// Claudesk notification service worker.
//
// The bridge pushes a notification here whenever the official Desktop decides
// to show one and no Claudesk page is connected (bridge/notifications.mjs); the
// page itself renders notifications over its event stream while it is open.
// This worker shows the pushed record and, on a click, runs the same click-back
// the page does — the bridge answers with the route the official handler
// navigated to, which the worker opens (or forwards to an existing window).
//
// It deliberately has no fetch handler: the app's requests must not be
// intercepted by the notification worker.
//
// Only the payload shape the bridge sends is handled; every field is treated
// as data (bounded strings), never as markup.

const fallbackRoute = "/";
// The official Desktop app icon, served same-origin (and already the PWA icon).
// Chrome renders it on Windows and Linux; macOS shows the browser icon instead.
const notificationIcon = "/desktop-icon.png";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function bounded(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function safeRoute(value) {
  const route = bounded(value, 500);
  if (!route.startsWith("/") || route.startsWith("//")) return null;
  return route;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {}
  const title = bounded(payload?.title, 200) || "Claude";
  // `renotify` requires a tag, so one is always present: the bridge sends the
  // official tag, and a payload without one gets a fresh unique tag (a unique
  // tag also keeps such a notification out of any other's replacement slot).
  const tag = bounded(payload?.tag, 200) || `claudesk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const kind = bounded(payload?.kind, 32);
  const options = {
    body: bounded(payload?.body, 400),
    icon: notificationIcon,
    tag,
    // A replacement for the same tag re-alerts (the platform's default sound)
    // instead of quietly swapping the text.
    renotify: true,
    data: {
      tag: bounded(payload?.tag, 200) || tag,
      route: safeRoute(payload?.route),
      kind,
      allowOnce: payload?.allowOnce === true,
    },
  };
  // Permission and question cards must not slide away unread; a finished turn
  // may dismiss itself like the desktop notification would.
  if (kind === "permission" || kind === "ask") {
    options.requireInteraction = true;
  }
  // Permission cards can be answered straight from the notification. Deny is
  // always possible; "Allow once" only when the official notification offered
  // it (a tool that runs on the user's own machine does not). The official web
  // push had the same deny-only variant.
  if (kind === "permission") {
    options.actions = options.data.allowOnce
      ? [{ action: "allow_once", title: "Allow once" }, { action: "deny", title: "Deny" }]
      : [{ action: "deny", title: "Deny" }];
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

async function reportClick(data, action) {
  try {
    const response = await fetch("/api/remote/notifications/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag: bounded(data?.tag, 200),
        action: action === "allow_once" || action === "deny" ? action : "default",
      }),
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json().catch(() => ({}));
    return safeRoute(body?.value?.route) ?? null;
  } catch {
    return null;
  }
}

async function focusOrOpen(route) {
  const target = route ?? fallbackRoute;
  const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clientList) {
    if (!("focus" in client)) continue;
    await client.focus();
    client.postMessage({ type: "claudesk-notification-navigate", route: target });
    return;
  }
  await self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  const data = event.notification?.data ?? {};
  event.notification?.close?.();
  // Answering a permission card ("Allow once" / "Deny") must not steal focus or
  // navigate, matching the app's own notification actions.
  const answersPermission = data.kind === "permission"
    && (event.action === "allow_once" ? data.allowOnce === true : event.action === "deny");
  if (answersPermission) {
    event.waitUntil(reportClick(data, event.action === "deny" ? "deny" : "allow_once"));
    return;
  }
  event.waitUntil((async () => {
    const route = await reportClick(data, "default");
    await focusOrOpen(route ?? safeRoute(data.route));
  })());
});
