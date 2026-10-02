#!/usr/bin/env node
// TOTP primitives checked against the RFC 6238 SHA-1 test vectors (Appendix B).
import assert from "node:assert/strict";
import { lockoutBucket } from "../mobile/auth.mjs";
import {
  base32Decode,
  base32Encode,
  generateSecret,
  hotp,
  otpauthUri,
  totpCounter,
  verifyTotp,
} from "../mobile/totp.mjs";

const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // ASCII "12345678901234567890"
assert.equal(base32Decode(rfcSecret).toString("ascii"), "12345678901234567890");
assert.equal(base32Encode(Buffer.from("12345678901234567890")), rfcSecret);
assert.equal(base32Decode("gezd gnbv-gy3t qojq gezdgnbvgy3tqojq").length, 20, "spaces, dashes and case are ignored");
assert.throws(() => base32Decode("not base32!"), /base32/);
assert.throws(() => base32Decode(""), /base32/);

// RFC vectors are 8 digits; the 6-digit code is the same value modulo 10^6.
const vectors = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];
const key = base32Decode(rfcSecret);
for (const [seconds, code] of vectors) {
  assert.equal(hotp(key, totpCounter(seconds * 1000)), code, `T=${seconds}`);
}

// Clock drift: the previous, current and next step are accepted; others are not.
const now = 1111111109 * 1000;
const counter = totpCounter(now);
const code = hotp(key, counter);
assert.equal(verifyTotp({ secret: rfcSecret, code, nowMs: now }), counter);
for (const offset of [-1, 1]) {
  const shifted = now + offset * 30_000;
  assert.equal(verifyTotp({ secret: rfcSecret, code, nowMs: shifted }), counter, `drift ${offset}`);
}
for (const offset of [-2, 2]) {
  assert.equal(verifyTotp({ secret: rfcSecret, code, nowMs: now + offset * 30_000 }), null, `drift ${offset}`);
}

// A used step cannot be redeemed again, but the next step still can.
assert.equal(verifyTotp({ secret: rfcSecret, code, nowMs: now, minCounter: counter }), null);
assert.equal(verifyTotp({ secret: rfcSecret, code, nowMs: now, minCounter: counter - 1 }), counter);
const next = hotp(key, counter + 1);
assert.equal(verifyTotp({ secret: rfcSecret, code: next, nowMs: now, minCounter: counter }), counter + 1);

// Malformed input is rejected rather than coerced.
for (const bad of ["", "12345", "1234567", "abcdef", " 287082", 287082, null, undefined, "000000\n"]) {
  assert.equal(verifyTotp({ secret: rfcSecret, code: bad, nowMs: 59_000 }), null, String(bad));
}
assert.notEqual(verifyTotp({ secret: rfcSecret, code: "287082", nowMs: 59_000 }), null);

// Generated secrets are 160-bit base32 and round-trip.
const secret = generateSecret();
assert.match(secret, /^[A-Z2-7]{32}$/);
assert.equal(base32Decode(secret).length, 20);
assert.notEqual(generateSecret(), secret);

const uri = new URL(otpauthUri({ secret, account: "me@example.com", issuer: "Claudesk" }));
assert.equal(uri.protocol, "otpauth:");
assert.equal(uri.hostname, "totp");
assert.equal(decodeURIComponent(uri.pathname), "/Claudesk:me@example.com");
assert.equal(uri.searchParams.get("secret"), secret);
assert.equal(uri.searchParams.get("digits"), "6");
assert.equal(uri.searchParams.get("period"), "30");
assert.equal(uri.searchParams.get("algorithm"), "SHA1");

// Lockout buckets: IPv4 as is, IPv6 by /64, IPv4-mapped IPv6 as IPv4.
assert.equal(lockoutBucket("203.0.113.9"), "203.0.113.9");
assert.equal(lockoutBucket("::ffff:203.0.113.9"), "203.0.113.9");
assert.equal(lockoutBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
assert.equal(lockoutBucket("2001:DB8:1:2::1"), "2001:db8:1:2::/64");
assert.equal(lockoutBucket("2001:db8:1:2:ffff::9"), lockoutBucket("2001:db8:1:2::1"));
assert.notEqual(lockoutBucket("2001:db8:1:3::1"), lockoutBucket("2001:db8:1:2::1"));
assert.equal(lockoutBucket("2001:db8::1"), "2001:db8:0:0::/64");
assert.equal(lockoutBucket("::1"), "0:0:0:0::/64");
assert.equal(lockoutBucket("unknown"), "unknown");

console.log("totp-smoke: RFC 6238 vectors, drift window, replay guard and input validation passed");
