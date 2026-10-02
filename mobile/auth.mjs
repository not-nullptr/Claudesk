import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { base32Decode, verifyTotp } from "./totp.mjs";

// Single-user login plus a persisted fail2ban-style lockout. The mobile
// client's numeric "email code" box takes the current TOTP code from an
// authenticator app; there is no static code and no password. A code is
// accepted once (replays within its validity window are rejected). Failures
// are recorded per client IP, with exponential lockout once the failure
// threshold is reached, and every decision is logged as a structured stderr
// line.
//
// CLAUDE_MOBILE_TRUST_PROXY is the number of reverse proxies in front of this
// service. The client address is then the Nth entry from the right of
// X-Forwarded-For, i.e. the one the nearest trusted proxy appended, which a
// client cannot forge. With 0 (the default) the header is ignored.

const totpStateFile = "totp-state.json";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// Lockout bucket for a client address. An IPv6 client usually controls a whole
// /64, so rotating the host part must not escape the lockout: those addresses
// share one bucket. IPv4-mapped addresses are treated as IPv4.
export function lockoutBucket(address) {
  const ip = String(address || "unknown");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back]
    : front;
  const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group || "0", 16));
  if (prefix.length < 4 || prefix.some((group) => !Number.isFinite(group))) return ip;
  return `${prefix.map((group) => group.toString(16)).join(":")}::/64`;
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
  const totpSecret = String(process.env.CLAUDE_MOBILE_API_TOTP_SECRET || "").replace(/\s+/g, "");
  const trustedProxyHops = clampInt(process.env.CLAUDE_MOBILE_TRUST_PROXY, 0, 5, 0);
  let totpSecretValid = false;
  try {
    // 80 bits is the smallest key an authenticator app will accept.
    totpSecretValid = base32Decode(totpSecret).length >= 10;
  } catch {
    totpSecretValid = false;
  }
  if (totpSecret && !totpSecretValid) {
    console.error("[mobile-auth] CLAUDE_MOBILE_API_TOTP_SECRET is not a valid base32 key; login is disabled");
  }
  if (process.env.CLAUDE_MOBILE_API_CODE || process.env.CLAUDE_MOBILE_API_PASSWORD) {
    console.error("[mobile-auth] CLAUDE_MOBILE_API_CODE and CLAUDE_MOBILE_API_PASSWORD are ignored; login uses TOTP only");
  }
  const maxFailures = clampInt(process.env.CLAUDE_MOBILE_API_MAX_FAILURES, 3, 20, 5);
  const baseBanSeconds = clampInt(
    process.env.CLAUDE_MOBILE_API_BASE_BAN_SECONDS,
    60,
    86_400,
    600,
  );

  function configured() {
    return Boolean(configuredEmail && totpSecretValid);
  }

  function clientIp(request) {
    const socketAddress = request.socket?.remoteAddress || "unknown";
    if (!trustedProxyHops) return lockoutBucket(socketAddress);
    const forwarded = request.headers["x-forwarded-for"];
    const hops = typeof forwarded === "string"
      ? forwarded.split(",").map((hop) => hop.trim()).filter(Boolean)
      : [];
    return lockoutBucket((hops[hops.length - trustedProxyHops] || socketAddress).slice(0, 64));
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
  async function assertNotLocked(request) {
    const ip = clientIp(request);
    const remaining = await lockedRemaining((await bans()).entries[`client:${ip}`]);
    if (remaining > 0) {
      console.error(`[mobile-auth] deny ip=${ip} remaining=${remaining}s`);
      const error = new AuthError(
        "too many failed sign-in attempts; try again later",
        429,
        "rate_limit_error",
      );
      error.retryAfter = remaining;
      throw error;
    }
  }

  async function recordFailure(request) {
    const ip = clientIp(request);
    const value = await bans();
    const now = Date.now();
    // Earlier versions also locked out per email; those entries are dead.
    for (const banKey of Object.keys(value.entries)) {
      if (banKey.startsWith("email:")) delete value.entries[banKey];
    }
    const entry = value.entries[`client:${ip}`] || {
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
    value.entries[`client:${ip}`] = entry;
    // Persisted with the same atomic write discipline as everything else, so
    // restarts do not reset the lockout counter.
    await store.saveBans(value);
    const locked = Number(entry.lockedUntil || 0) > now;
    console.error(
      `[mobile-auth] failure ip=${ip} failures=${entry.failures}${locked ? " BANNED" : ""}`,
    );
  }

  async function resetFailures(request) {
    const ip = clientIp(request);
    const value = await bans();
    if (value.entries[`client:${ip}`]) {
      delete value.entries[`client:${ip}`];
      await store.saveBans(value);
    }
  }

  // Checks the submitted code against the current TOTP window and, only for
  // the configured account, records the time step as used so the same code
  // cannot log in twice. Serialised so two concurrent requests cannot both
  // redeem one code. The code is evaluated even for a wrong email, so the two
  // failure causes take the same path.
  let redeemQueue = Promise.resolve();
  function redeemTotp(code, emailOk) {
    const run = redeemQueue.then(async () => {
      const state = await store.readJsonFile(totpStateFile, { lastCounter: -1 });
      const counter = verifyTotp({
        secret: totpSecret,
        code,
        minCounter: Number(state?.lastCounter ?? -1),
      });
      if (!emailOk || counter === null) return false;
      await store.writeJsonFile(totpStateFile, { lastCounter: counter });
      return true;
    });
    redeemQueue = run.catch(() => {});
    return run;
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
  async function sendMagicLink(request) {
    await assertNotLocked(request);
    if (!configured()) {
      throw new AuthError(
        "no mobile API credentials (email and TOTP secret) are configured on this deployment",
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
    await assertNotLocked(request);
    if (!configured()) {
      throw new AuthError("no credentials configured", 501, "configuration_error");
    }
    const { key, emailOk } = credentialsFor(email);
    const credentials = payload?.credentials || {};
    const providedCode = credentials.method === "code"
      ? String(credentials.code ?? "")
      : "";
    const codeOk = await redeemTotp(providedCode, emailOk);
    if (!emailOk || !codeOk) {
      await recordFailure(request);
      // Uniform rejection regardless of which half failed.
      throw new AuthError(
        "that email or code is incorrect",
        401,
        "authentication_error",
      );
    }
    await resetFailures(request);
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
