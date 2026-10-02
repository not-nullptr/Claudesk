import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 6238 TOTP with the parameters every authenticator app supports
// (HMAC-SHA1, 6 digits, 30 second step). Google Authenticator ignores other
// parameters, so they are deliberately not configurable.

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const stepSeconds = 30;
export const digits = 6;

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  const cleaned = String(text || "").replace(/[\s=-]/g, "").toUpperCase();
  if (!cleaned || /[^A-Z2-7]/.test(cleaned)) {
    throw new Error("not a valid base32 string");
  }
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of cleaned) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// 160 bits, the size RFC 4226 recommends for an HMAC-SHA1 key.
export function generateSecret() {
  return base32Encode(randomBytes(20));
}

export function hotp(key, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpCounter(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

// Returns the time step the code belongs to, or null. Steps at or below
// minCounter were already used and are rejected (RFC 6238 section 5.2), which
// stops a code from being replayed inside its validity window. Every step in
// the window is checked without an early exit.
export function verifyTotp({ secret, code, nowMs = Date.now(), window = 1, minCounter = -1 }) {
  const key = base32Decode(secret);
  const submitted = Buffer.from(typeof code === "string" && /^\d{6}$/.test(code) ? code : "------");
  const current = totpCounter(nowMs);
  let matched = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset;
    if (counter < 0) continue;
    const expected = Buffer.from(hotp(key, counter));
    const equal = submitted.length === expected.length && timingSafeEqual(submitted, expected);
    if (equal && counter > minCounter && (matched === null || counter > matched)) {
      matched = counter;
    }
  }
  return matched;
}

export function otpauthUri({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(stepSeconds),
  });
  return `otpauth://totp/${label}?${query}`;
}
