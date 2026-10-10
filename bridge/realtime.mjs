import { createHash } from "node:crypto";

const transcriptSnapshotLimit = 16;
const transcriptSnapshotTtlMs = 15 * 60 * 1000;

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")
    .slice(0, 20);
}

function summarizeSession(session) {
  return {
    sessionId: session.sessionId,
    sessionType: session.sessionType ?? null,
    title: session.title ?? null,
    initialMessage: session.initialMessage ?? null,
    model: session.model ?? null,
    isRunning: Boolean(session.isRunning),
    isArchived: Boolean(session.isArchived),
    createdAt: session.createdAt ?? null,
    lastActivityAt: session.lastActivityAt ?? null,
  };
}

export function createRealtimeController({
  desktop,
  isChatSession,
  ApiError,
  // Optional gate for relayed Desktop events. The notification controller uses
  // it to drop notifications whose category the settings panel turned off, so
  // a disabled category never reaches an open tab either.
  eventAllowed = () => true,
}) {
  const clients = new Map();
  const transcripts = new Map();
  let latestSessions = null;
  let latestSessionsDigest = "";
  let revision = 0;
  let statePollInFlight = false;
  let eventPollInFlight = false;
  let eventRevision = 0;
  const lastSessionEvent = new Map();
  let lastClientSeenAt = 0;
  // clientId → last seen, for browsers whose SSE connection has ended (the
  // push side must not deliver to a page that is still open).
  const recentClientIds = new Map();

  function send(response, event, data) {
    if (response.destroyed || response.writableEnded) return false;
    try {
      revision += 1;
      response.write(`id: ${revision}\n`);
      response.write(`event: ${event}\n`);
      response.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      clients.delete(response);
      return false;
    }
  }

  function broadcast(event, data, predicate = () => true) {
    for (const [response, subscription] of clients) {
      if (predicate(subscription)) send(response, event, data);
    }
  }

  async function pollState() {
    if (!clients.size || statePollInFlight) return;
    statePollInFlight = true;
    try {
      await pollDesktopEvents();
      const sessions = await desktop.invoke("LocalAgentModeSessions", "getAll", []);
      const summaries = sessions.map(summarizeSession);
      const snapshot = {
        chat: summaries.filter(isChatSession),
        cowork: summaries.filter((session) => !isChatSession(session)),
        observedAt: new Date().toISOString(),
      };
      const sessionsDigest = digest({ chat: snapshot.chat, cowork: snapshot.cowork });
      if (sessionsDigest !== latestSessionsDigest) {
        latestSessions = snapshot;
        latestSessionsDigest = sessionsDigest;
        broadcast("sessions", snapshot);
      }

      const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
      const selectedIds = new Set(
        [...clients.values()].map((item) => item.sessionId).filter(Boolean),
      );
      const now = Date.now();
      for (const [sessionId, snapshotValue] of transcripts) {
        if (
          !selectedIds.has(sessionId)
          || now - (snapshotValue.lastAccessedAt ?? snapshotValue.polledAt)
            > transcriptSnapshotTtlMs
        ) transcripts.delete(sessionId);
      }
      for (const sessionId of selectedIds) {
        const session = sessionsById.get(sessionId);
        if (!session) continue;
        // Native stream deltas own active turns. Disk-backed snapshots may lag
        // those deltas and reset the reducer's active content-block indexes.
        if (session.isRunning) {
          transcripts.delete(sessionId);
          continue;
        }
        if (now - (lastSessionEvent.get(sessionId) || 0) < 1500) continue;
        const previous = transcripts.get(sessionId);
        const activityKey = `${session.lastActivityAt ?? ""}:${Boolean(session.isRunning)}`;
        const shouldPoll = !previous
          || previous.activityKey !== activityKey
          || now - previous.polledAt >= 10000;
        if (!shouldPoll) continue;

        try {
          const before = eventRevision;
          const transcript = await desktop.invoke(
            "LocalAgentModeSessions",
            "getTranscript",
            [sessionId],
          );
          // Drain events queued during the read before publishing a snapshot.
          // If a turn started while it was being read, discard that snapshot.
          await pollDesktopEvents();
          if (eventPollInFlight || before !== eventRevision) continue;
          const transcriptDigest = digest(transcript);
          transcripts.set(sessionId, {
            activityKey,
            digest: transcriptDigest,
            isRunning: Boolean(session.isRunning),
            lastAccessedAt: now,
            polledAt: now,
            value: transcript,
          });
          while (transcripts.size > transcriptSnapshotLimit) {
            transcripts.delete(transcripts.keys().next().value);
          }
          if (transcriptDigest !== previous?.digest || activityKey !== previous?.activityKey) {
            broadcast(
              "transcript",
              {
                sessionId,
                value: transcript,
                isRunning: Boolean(session.isRunning),
                observedAt: new Date().toISOString(),
              },
              (subscription) => subscription.sessionId === sessionId,
            );
          }
        } catch (error) {
          broadcast(
            "sync-error",
            { sessionId, error: error.message },
            (subscription) => subscription.sessionId === sessionId,
          );
        }
      }
    } catch (error) {
      broadcast("sync-error", { error: error.message });
    } finally {
      statePollInFlight = false;
    }
  }

  async function pollDesktopEvents() {
    if (!clients.size || eventPollInFlight) return;
    eventPollInFlight = true;
    try {
      const events = await desktop.pollEvents();
      for (const event of events) {
        eventRevision++;
        if (event.surface === "DesktopNotifications" && !eventAllowed(event.payload)) continue;
        const sessionId = event.payload?.sessionId;
        if (sessionId) {
          lastSessionEvent.set(sessionId, Date.now());
          transcripts.delete(sessionId);
        }
        broadcast("desktop-ipc", event);
      }
      for (const id of lastSessionEvent.keys()) {
        if (![...clients.values()].some(client => client.sessionId === id)) lastSessionEvent.delete(id);
      }
    } catch (error) {
      broadcast("sync-error", { error: error.message });
    } finally {
      eventPollInFlight = false;
    }
  }

  function open(request, response, url) {
    const mode = url.searchParams.get("mode") || "chat";
    const sessionId = url.searchParams.get("sessionId") || null;
    const rawClientId = url.searchParams.get("clientId") || "";
    const clientId = /^[A-Za-z0-9-]{1,64}$/.test(rawClientId) ? rawClientId : "";
    if (!new Set(["chat", "cowork", "code"]).has(mode)) {
      throw new ApiError(400, "invalid realtime mode");
    }
    if (sessionId && (sessionId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(sessionId))) {
      throw new ApiError(400, "invalid realtime sessionId");
    }

    response.writeHead(200, {
      "Cache-Control": "no-cache, no-store, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    response.write(": connected\n\n");
    lastClientSeenAt = Date.now();
    if (clientId) recentClientIds.set(clientId, Date.now());
    clients.set(response, { mode, sessionId, clientId });
    send(response, "hello", {
      ok: true,
      transport: "server-sent-events",
      mode,
      sessionId,
    });
    if (latestSessions) send(response, "sessions", latestSessions);
    // Reconcile from a fresh read after draining pending native events. A
    // cached transcript could predate a turn that started before reconnect.
    void pollState();

    const close = () => {
      clients.delete(response);
      if (
        sessionId
        && ![...clients.values()].some((subscription) => subscription.sessionId === sessionId)
      ) transcripts.delete(sessionId);
    };
    request.on("close", close);
    response.on("close", close);
  }

  function pruneClosedClients() {
    for (const response of clients.keys()) {
      if (response.destroyed || response.writableEnded) clients.delete(response);
    }
  }

  // True while some page is (or was very recently) connected: that page renders
  // relayed notifications itself, and a push as well would double them. With a
  // client id the answer is per browser (a subscription whose page is open
  // elsewhere gets no push; every other browser still does). The grace window
  // covers a tab that just closed between a notification being queued and
  // delivered.
  function hasRecentClient(clientId, maxAgeMs = 30000) {
    const now = Date.now();
    if (typeof clientId === "string" && clientId) {
      for (const subscription of clients.values()) {
        if (subscription.clientId === clientId) return true;
      }
      const seenAt = recentClientIds.get(clientId);
      return seenAt !== undefined && now - seenAt <= maxAgeMs;
    }
    return clients.size > 0 || now - lastClientSeenAt <= maxAgeMs;
  }

  function heartbeat() {
    pruneClosedClients();
    for (const response of clients.keys()) response.write(`: heartbeat ${Date.now()}\n\n`);
    const now = Date.now();
    for (const [clientId, seenAt] of recentClientIds) {
      if (now - seenAt > 5 * 60 * 1000) recentClientIds.delete(clientId);
    }
  }

  return { hasRecentClient, heartbeat, open, pollDesktopEvents, pollState };
}
