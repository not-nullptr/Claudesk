import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The gateway upstream never sends personalized_greeting, so the official home
// greeting sits on the renderer's "You're here!" placeholder. The bridge fills
// the same slot shape the real backend sends — both the chat and code surfaces,
// each with per-weekday slots and a default_slots fallback — and expands the
// {{ NAME }} token server-side the way the official backend does, addressing the
// user by the same name the rest of the app shows. These checks pin that shape,
// the per-day pick, the token expansion and the name precedence so a refactor
// cannot quietly drop any of them.
const serverSource = await readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const nameSection = section(serverSource, "const remoteUserName =", "const workspaceRoot =");
const greetingSection = section(
  serverSource,
  "const bootstrapResponsePath",
  "function containsSensitiveCredential",
);
const storeSection = section(
  serverSource,
  "function sanitizeStoreValue",
  "const bootstrapResponsePath",
);

// The bridge sections under test run in a different realm, so values they build
// are round-tripped through JSON before deep comparison (strict deepEqual also
// compares prototypes, which differ across realms).
function load(userName) {
  const sandbox = { process: { env: {} } };
  vm.runInNewContext(
    `${nameSection.replace(
      /const remoteUserName = .*/,
      `const remoteUserName = ${JSON.stringify(userName)};`,
    )}
     ${greetingSection}
     ${storeSection}
     result = {
       inject: (value, name) => injectPersonalizedGreeting(value, name),
       resolve: resolveGreetingName,
       store: (value) => sanitizeStoreValue("LocalAgentModeSessions", "interactiveAuthStore", value),
     };`,
    sandbox,
  );
  const { inject, resolve, store } = sandbox.result;
  // Round-trip through this realm's JSON so strict deepEqual (which also
  // compares prototypes) sees main-realm objects.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return {
    inject: (value, name) => inject(value, name),
    injectPlain: (value, name) => plain(inject(value, name)),
    resolve,
    storePlain: (value) => plain(store(value)),
  };
}

// The renderer's own picker (ion-dist "JC"): the matched day's slots when the
// weekday matches, else default_slots; then the first slot whose exclusive
// `until` hour is still ahead of the local clock.
const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function rendererPick(greeting, surface, date) {
  const found = greeting.find((entry) => entry.surface === surface);
  const slots = found?.days?.find((day) => day.day === dayNames[date.getDay()])?.slots
    ?? found?.default_slots;
  return slots?.find((slot) => date.getHours() < slot.until)?.text;
}
function pick(greeting, surface, hour, day) {
  return rendererPick(greeting, surface, at(hour, day));
}

// 2026-01-04 is a Sunday, so day 0..6 lands on sun..sat.
function at(hour, day = 1) {
  return new Date(2026, 0, 4 + day, hour, 30, 0);
}

const bare = load("");
const named = load("Ada");

// 1. An empty upstream bootstrap gets both official surfaces, and every hour of
//    every weekday resolves to some greeting text.
const injected = bare.injectPlain({ account: { uuid: "u" } }, "");
assert.deepEqual(
  injected.personalized_greeting.map((entry) => entry.surface),
  ["chat", "code"],
);
for (const entry of injected.personalized_greeting) {
  assert.ok(entry.default_slots.length > 0, `${entry.surface} has default_slots`);
  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      assert.equal(
        typeof pick(injected.personalized_greeting, entry.surface, hour, day),
        "string",
        `no greeting slot for ${entry.surface} day ${day} hour ${hour}`,
      );
    }
  }
}

// 2. The per-weekday slots are the ones the renderer picks (and the code surface
//    falls back to default_slots on a day it does not define, like Thursday).
assert.equal(pick(injected.personalized_greeting, "chat", 3, 0), "What shall we think through?"); // sun <5
assert.equal(pick(injected.personalized_greeting, "chat", 6, 1), "Hey there"); // mon <9
assert.equal(pick(injected.personalized_greeting, "chat", 20, 2), "Evening"); // tue <22
assert.equal(pick(injected.personalized_greeting, "code", 6, 0), "Morning"); // sun <12
assert.equal(pick(injected.personalized_greeting, "code", 6, 1), "Hello, world"); // mon <18, no name
assert.equal(pick(injected.personalized_greeting, "code", 6, 4), "Back at it"); // thu -> default_slots <12

// 3. A resolved name is expanded into every slot that carries the token, and the
//    token never leaks.
const addressed = named.injectPlain({}, "Ada");
assert.equal(pick(addressed.personalized_greeting, "chat", 6, 1), "Hey there, Ada");
assert.equal(pick(addressed.personalized_greeting, "chat", 14, 1), "Afternoon, Ada");
assert.equal(pick(addressed.personalized_greeting, "chat", 6, 0), "Sunday session, Ada?");
assert.equal(pick(addressed.personalized_greeting, "code", 6, 4), "Back at it, Ada");
assert.ok(!JSON.stringify(addressed).includes("{{"));

// 4. With no name at all, the token is dropped without stray punctuation.
assert.equal(pick(injected.personalized_greeting, "chat", 1, 1), "Up late?"); // "Up late, {{ NAME }}?"
assert.equal(pick(injected.personalized_greeting, "chat", 6, 0), "Sunday session?");
assert.equal(pick(injected.personalized_greeting, "chat", 20, 0), "Returns!"); // leading token
assert.ok(!JSON.stringify(injected).includes("{{"));

// 5. Name precedence: override > the app-wide reported name > account > none.
assert.equal(bare.resolve({ override: "Ada", reported: "app", account: { display_name: "Maddie" } }), "Ada");
assert.equal(bare.resolve({ override: "", reported: "app", account: { display_name: "Maddie" } }), "app");
assert.equal(bare.resolve({ override: "", reported: "", account: { display_name: "Maddie" } }), "Maddie");
assert.equal(bare.resolve({ override: "", reported: "", account: { full_name: "Grace Hopper" } }), "Grace Hopper");
assert.equal(bare.resolve({ override: "", reported: "", account: { display_name: "Maddie", full_name: "Maddie Ross" } }), "Maddie");
assert.equal(bare.resolve({ override: "", reported: "", account: {} }), "");
assert.equal(bare.resolve({}), "");
// The reported app name is what the greeting actually renders.
const asApp = bare.injectPlain({ account: { display_name: "Maddie" } }, "app");
assert.equal(pick(asApp.personalized_greeting, "chat", 6, 1), "Hey there, app");

// 6. A greeting the upstream did send is left untouched (same object back).
const upstream = {
  personalized_greeting: [{ surface: "chat", default_slots: [{ until: 24, text: "Hi" }] }],
};
assert.equal(bare.inject(upstream), upstream);
// An empty array counts as "not sent" and is filled in.
assert.deepEqual(
  bare.injectPlain({ personalized_greeting: [] }, "app").personalized_greeting.map((entry) => entry.surface),
  ["chat", "code"],
);
// Non-object bodies are passed through rather than throwing.
assert.equal(bare.inject(null), null);
assert.deepEqual(bare.injectPlain([1, 2]), [1, 2]);

// 7. The user-menu identity: Desktop reports the OS app user, the name override
//    wins when set, and an unset name keeps what Desktop reported.
assert.deepEqual(bare.storePlain({ principalDisplayName: "app" }), { principalDisplayName: "app" });
assert.deepEqual(named.storePlain({ principalDisplayName: "app" }), { principalDisplayName: "Ada" });
assert.deepEqual(named.storePlain({}), { principalDisplayName: "Ada" });
assert.deepEqual(bare.storePlain({}), { principalDisplayName: null });

process.stdout.write("greeting-smoke: bootstrap greeting and user-name override behave\n");
