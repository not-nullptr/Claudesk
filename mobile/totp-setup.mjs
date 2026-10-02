#!/usr/bin/env node
// One-off enrollment: generates a TOTP secret for the mobile API login.
//
//   node mobile/totp-setup.mjs [account-email]
//
// Add the printed key to an authenticator app, check that the app shows the
// same code as "Current code" below, then put the secret in .env as
// CLAUDE_MOBILE_API_TOTP_SECRET. The secret is only printed here; keep a copy in
// a password manager, because it is the only way to log in.
import { base32Decode, generateSecret, hotp, otpauthUri, totpCounter } from "./totp.mjs";

const account = process.argv[2] || process.env.CLAUDE_MOBILE_API_EMAIL || "mobile";
const secret = generateSecret();
const current = hotp(base32Decode(secret), totpCounter());

console.log(`Account:        ${account}`);
console.log(`Setup key:      ${secret}`);
console.log(`otpauth URI:    ${otpauthUri({ secret, account, issuer: "Claudesk" })}`);
console.log(`Current code:   ${current}  (should match your authenticator app)`);
console.log("");
console.log("Add this line to .env, then recreate the mobile service:");
console.log(`CLAUDE_MOBILE_API_TOTP_SECRET=${secret}`);
