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
  const options = {
    body: bounded(payload?.body, 400),
    tag: bounded(payload?.tag, 200) || undefined,
    data: {
      tag: bounded(payload?.tag, 200),
      route: safeRoute(payload?.route),
      kind: bounded(payload?.kind, 32),
      allowOnce: payload?.allowOnce === true,
    },
  };
  // Permission cards can be answered straight from the notification, the way
  // the app's own native notification offers "Allow once".
  if (options.data.allowOnce && options.data.kind === "permission") {
    options.actions = [{ action: "allow_once", title: "Allow once" }];
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
        action: action === "allow_once" ? "allow_once" : "default",
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
  if (event.action === "allow_once" && data.allowOnce) {
    event.waitUntil(reportClick(data, "allow_once"));
    return;
  }
  event.waitUntil((async () => {
    const route = await reportClick(data, "default");
    await focusOrOpen(route ?? safeRoute(data.route));
  })());
});
