// Web Push delivery for the browser notifications the wrapper relays out of the
// Desktop main process (see bridge-wrapper/main.cjs and bridge/notifications.mjs).
//
// A browser that has notifications enabled also registers a push subscription
// (bridge/public/sw.js receives the messages), so a notification can still
// arrive when no Claudesk tab is open. This is the minimal sender the push
// protocol needs — RFC 8030 (delivery), RFC 8188 (aes128gcm content encoding)
// and RFC 8291 (message encryption for Web Push) — implemented on node:crypto
// so the bridge stays dependency-free. The smoke test pins the RFC 8291
// Appendix A test vector, so a mistake in the key derivation cannot pass.

import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";

// aes128gcm header (21 bytes) + keyid (65 bytes) + ciphertext (payload + 1-byte
// record delimiter + 16-byte tag) must fit the push service's 4096-byte body
// limit, so the plaintext is capped well below it.
export const maxPushPayloadBytes = 3000;
const recordSize = 4096;

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

export function generateVapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: base64Url(ecdh.getPublicKey()),
    privateKey: base64Url(ecdh.getPrivateKey()),
  };
}

function vapidKeyObject(keys) {
  const publicKey = Buffer.from(keys.publicKey, "base64url");
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("VAPID public key must be an uncompressed P-256 point");
  }
  const privateKey = Buffer.from(keys.privateKey, "base64url");
  if (privateKey.length !== 32) throw new Error("VAPID private key must be a P-256 scalar");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: base64Url(publicKey.subarray(1, 33)),
      y: base64Url(publicKey.subarray(33, 65)),
      d: base64Url(privateKey),
    },
    format: "jwk",
  });
}

// `Authorization: vapid t=<ES256 JWT>, k=<public key>`. The signature must be
// the raw 64-byte r||s form (JOSE), which `dsaEncoding: "ieee-p1363"` produces.
export function vapidAuthorization(endpoint, keys, subject, nowMs = Date.now()) {
  const audience = new URL(endpoint).origin;
  const header = base64Url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64Url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(nowMs / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: vapidKeyObject(keys),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${signingInput}.${base64Url(signature)}, k=${keys.publicKey}`;
}

// RFC 8291 §3.4: derive the CEK/nonce from the ECDH shared secret and the
// subscription's auth secret through the two-step HKDF. `override` exists so
// the smoke test can pin the RFC's fixed sender key and salt.
export function encryptPushPayload(subscription, plaintext, override = {}) {
  const uaPublic = Buffer.from(subscription.keys.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.keys.auth, "base64url");
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error("push subscription p256dh must be an uncompressed P-256 point");
  }
  if (authSecret.length !== 16) {
    throw new Error("push subscription auth secret must be 16 bytes");
  }
  let ephemeral = override.ephemeral;
  if (!ephemeral) {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    ephemeral = { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() };
  }
  const salt = override.salt ?? randomBytes(16);
  const asPublic = Buffer.from(ephemeral.publicKey);
  const senderEcdh = createECDH("prime256v1");
  senderEcdh.setPrivateKey(Buffer.from(ephemeral.privateKey));
  const sharedSecret = senderEcdh.computeSecret(uaPublic);

  const ikm = Buffer.from(hkdfSync(
    "sha256",
    sharedSecret,
    authSecret,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32,
  ));
  const contentEncryptionKey = Buffer.from(hkdfSync(
    "sha256",
    ikm,
    salt,
    Buffer.from("Content-Encoding: aes128gcm\0"),
    16,
  ));
  const nonce = Buffer.from(hkdfSync(
    "sha256",
    ikm,
    salt,
    Buffer.from("Content-Encoding: nonce\0"),
    12,
  ));

  // A single record, marked as the last one (0x02 delimiter before padding).
  const record = Buffer.concat([Buffer.from(plaintext, "utf8"), Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", contentEncryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

export function parsePushSubscription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("push subscription must be an object");
  }
  const endpoint = typeof value.endpoint === "string" ? value.endpoint : "";
  // Browsers only ever hand out https push endpoints; the loopback exception
  // exists so the smoke test can stand in a local endpoint for a push service.
  const endpointAllowed = /^https:\/\//i.test(endpoint)
    || /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?\//i.test(endpoint);
  if (endpoint.length < 10 || endpoint.length > 2000 || !endpointAllowed) {
    throw new Error("push subscription endpoint must be an https URL");
  }
  const keys = value.keys && typeof value.keys === "object" ? value.keys : {};
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys.auth === "string" ? keys.auth : "";
  if (p256dh.length > 200 || auth.length > 100
    || !/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) {
    throw new Error("push subscription keys are invalid");
  }
  const decodedPublic = Buffer.from(p256dh, "base64url");
  const decodedAuth = Buffer.from(auth, "base64url");
  if (decodedPublic.length !== 65 || decodedPublic[0] !== 0x04) {
    throw new Error("push subscription p256dh must be an uncompressed P-256 point");
  }
  if (decodedAuth.length !== 16) {
    throw new Error("push subscription auth secret must be 16 bytes");
  }
  const expirationTime = Number.isFinite(value.expirationTime) ? value.expirationTime : null;
  return { endpoint, keys: { p256dh, auth }, expirationTime };
}

export async function sendPushNotification(subscription, payload, options) {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > maxPushPayloadBytes) {
    throw new Error("push payload is too large");
  }
  const body = encryptPushPayload(subscription, serialized);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": vapidAuthorization(subscription.endpoint, options.vapid, options.subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": String(options.ttl ?? 300),
      "Urgency": "normal",
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  return {
    status: response.status,
    // A push service that answers 404/410 has forgotten this subscription and
    // it must not be retried.
    gone: response.status === 404 || response.status === 410,
  };
}
