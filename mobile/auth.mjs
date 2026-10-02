import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

// Single-user login plus a persisted fail2ban-style lockout. Credentials come
// from the environment; every comparison is constant time over SHA-256 digests
// so timing never reveals which field mismatched. Failures are recorded per
// client IP and per email, with exponential lockout once the failure threshold
// is reached, and every decision is logged as a structured stderr line a
// host-side fail2ban can additionally consume.

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function digest(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest();
}

function constantTimeEquals(expected, provided) {
  if (typeof provided !== "string") return false;
  return timingSafeEqual(digest(expected), digest(provided));
}


/** Error carrying an HTTP status for the REST error envelope. */
export class AuthError extends Error {
  constructor(message, status, type) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export function createAuthService({ store, codeLength = 6 }) {
  const configuredEmail = normalizeEmail(process.env.CLAUDE_MOBILE_API_EMAIL);
  const configuredPassword = process.env.CLAUDE_MOBILE_API_PASSWORD || "";
  const configuredCode = String(process.env.CLAUDE_MOBILE_API_CODE || "");
  const maxFailures = clampInt(process.env.CLAUDE_MOBILE_API_MAX_FAILURES, 3, 20, 5);
  const baseBanSeconds = clampInt(
    process.env.CLAUDE_MOBILE_API_BASE_BAN_SECONDS,
    60,
    86_400,
    600,
  );

  function configured() {
    return Boolean(configuredEmail && configuredCode);
  }

  function clientIp(request) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length) {
      return forwarded.split(",")[0].trim().slice(0, 64) || "unknown";
    }
    return request.socket?.remoteAddress || "unknown";
  }

  async function bans() {
    const value = await store.loadBans();
    value.entries ||= {};
    return value;
  }

  async function lockedRemaining(entry) {
    if (!entry) return 0;
    const until = Number(entry.lockedUntil || 0);
    return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
  }

  // Lockout check shared by both login steps. Throws AuthError 429 with a
  // Retry-After value so the reverse proxy can also emit it.
  async function assertNotLocked(request, email) {
    const ip = clientIp(request);
    const key = normalizeEmail(email);
    const entries = (await bans()).entries;
    for (const [scope, entry] of [
      ["ip", entries[`client:${ip}`]],
      ["email", entries[`email:${key}`]],
    ]) {
      const remaining = await lockedRemaining(entry);
      if (remaining > 0) {
        console.error(
          `[mobile-auth] deny scope=${scope} ip=${ip} remaining=${remaining}s`,
        );
        const error = new AuthError(
          "too many failed sign-in attempts; try again later",
          429,
          "rate_limit_error",
        );
        error.retryAfter = remaining;
        throw error;
      }
    }
  }

  async function recordFailure(request, email) {
    const ip = clientIp(request);
    const key = normalizeEmail(email);
    const value = await bans();
    const now = Date.now();
    for (const banKey of [`client:${ip}`, `email:${key}`]) {
      const entry = value.entries[banKey] || {
        failures: 0,
        lockedUntil: 0,
        lastFailureAt: 0,
      };
      entry.failures = Number(entry.failures || 0) + 1;
      entry.lastFailureAt = now;
      if (entry.failures >= maxFailures) {
        // Exponential backoff: 2x per additional failure burst, capped growth.
        const over = Math.min(entry.failures - maxFailures, 6);
        entry.lockedUntil = now + baseBanSeconds * 1000 * 2 ** over;
      }
      value.entries[banKey] = entry;
    }
    // Persisted with the same atomic write discipline as everything else, so
    // restarts do not reset the lockout counter.
    await store.saveBans(value);
    const first = value.entries[`client:${ip}`];
    const locked = Number(first?.lockedUntil || 0) > now;
    console.error(
      `[mobile-auth] failure ip=${ip} email=${key.replace(/^(.{2}).*(@.*)$/, "$1***$2")}` +
        ` failures=${first?.failures}${locked ? " BANNED" : ""}`,
    );
  }

  async function resetFailures(request, email) {
    const ip = clientIp(request);
    const key = normalizeEmail(email);
    const value = await bans();
    let changed = false;
    for (const banKey of [`client:${ip}`, `email:${key}`]) {
      if (value.entries[banKey]) {
        delete value.entries[banKey];
        changed = true;
      }
    }
    if (changed) await store.saveBans(value);
  }

  function credentialsFor(email) {
    const key = normalizeEmail(email);
    const emailOk = configured()
      ? constantTimeEquals(configuredEmail, key)
      : false;
    return { key, emailOk };
  }

  // Step 1 of the numeric-code flow. Always answers with the same known-good
  // body so configured account addresses are not enumerable; whether the code
  // will actually be accepted is decided in verify().
  async function sendMagicLink(request, email) {
    await assertNotLocked(request, email);
    if (!configured()) {
      throw new AuthError(
        "no mobile API credentials are configured on this deployment",
        503,
        "configuration_error",
      );
    }
    return {
      sent: true,
      magic_link_intent_available: false,
      fallback_code_configuration: {
        charset: "numeric",
        length: codeLength,
        show_input_after_delay: 0,
      },
    };
  }

  // Step 2. On success creates the persistent session and returns the cookie
  // token; the server layer owns the Set-Cookie header.
  async function verifyMagicLink(request, email, payload) {
    await assertNotLocked(request, email);
    if (!configured()) {
      throw new AuthError("no credentials configured", 501, "configuration_error");
    }
    const { key, emailOk } = credentialsFor(email);
    const credentials = payload?.credentials || {};
    const providedCode = credentials.method === "code"
      ? String(credentials.code ?? "")
      : "";
    const codeOk = emailOk
      ? constantTimeEquals(configuredCode, providedCode)
      : false;
    // The mobile client only offers the numeric code flow, but a password
    // alternative is accepted for other clients; the code path is the one the
    // deployed device uses.
    const providedPassword = credentials.method === "password"
      ? String(credentials.password ?? "")
      : "";
    const passwordOk = emailOk && configuredPassword
      ? constantTimeEquals(configuredPassword, providedPassword)
      : false;
    if (!emailOk || (!codeOk && !passwordOk)) {
      await recordFailure(request, key);
      // Uniform rejection regardless of which half failed.
      throw new AuthError(
        "that email or code is incorrect",
        401,
        "authentication_error",
      );
    }
    await resetFailures(request, key);
    const token = await store.createSession(key);
    console.error(`[mobile-auth] success ip=${clientIp(request)} email=${key}`);
    return { token, email: key };
  }

  async function requireSession(request) {
    const token = parseCookie(request, "sessionKey");
    if (!token) return null;
    return (await store.touchSession(token)) ? token : null;
  }

  function sessionCookie(token, secure) {
    return [
      `sessionKey=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=2592000",
      secure ? "Secure" : "",
    ].filter(Boolean).join("; ");
  }

  function clearSessionCookie() {
    return "sessionKey=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";
  }

  function parseCookie(request, name) {
    const header = request.headers.cookie;
    if (typeof header !== "string" || !header.length) return null;
    for (const part of header.split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key === name) return decodeURIComponent(rest.join("="));
    }
    return null;
  }

  return {
    configured,
    clientIp,
    sendMagicLink,
    verifyMagicLink,
    requireSession,
    sessionCookie,
    clearSessionCookie,
    parseCookie,
  };
}
