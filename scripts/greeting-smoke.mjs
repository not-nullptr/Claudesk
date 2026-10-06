import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The gateway upstream never sends personalized_greeting, so the official home
// greeting sits on the renderer's "You're here!" placeholder. The bridge fills
// the same slot shape the real backend sends; these checks pin that shape and
// the name override so a refactor cannot quietly drop either.
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
       inject: injectPersonalizedGreeting,
       store: (value) => sanitizeStoreValue("LocalAgentModeSessions", "interactiveAuthStore", value),
     };`,
    sandbox,
  );
  const { inject, store } = sandbox.result;
  // Round-trip through this realm's JSON so strict deepEqual (which also
  // compares prototypes) sees main-realm objects.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return { inject, injectPlain: (value) => plain(inject(value)), storePlain: (value) => plain(store(value)) };
}

// The renderer's own picker (ion-dist "JC"): first slot whose exclusive
// `until` hour is still ahead of the local clock, day-specific slots first.
const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function rendererPick(greeting, surface, date) {
  const found = greeting.find((entry) => entry.surface === surface);
  const slots = found?.days?.find((day) => day.day === dayNames[date.getDay()])?.slots
    ?? found?.default_slots;
  return slots?.find((slot) => date.getHours() < slot.until)?.text;
}

function at(hour) {
  return new Date(2026, 0, 5, hour, 30, 0); // a Monday, local time
}

const bare = load("");
const named = load("Ada");

// 1. An empty upstream bootstrap gets the time-based greeting, for the chat
//    surface, with slots that cover every hour of the day.
const injected = bare.injectPlain({ account: { uuid: "u" } });
assert.equal(injected.personalized_greeting.length, 1);
assert.equal(injected.personalized_greeting[0].surface, "chat");
const slots = injected.personalized_greeting[0].default_slots;
assert.deepEqual(slots.map((slot) => slot.until), [5, 12, 17, 24]);
for (let hour = 0; hour < 24; hour += 1) {
  assert.equal(
    typeof rendererPick(injected.personalized_greeting, "chat", at(hour)),
    "string",
    `no greeting slot for hour ${hour}`,
  );
}
assert.equal(rendererPick(injected.personalized_greeting, "chat", at(0)), "Good evening");
assert.equal(rendererPick(injected.personalized_greeting, "chat", at(6)), "Good morning");
assert.equal(rendererPick(injected.personalized_greeting, "chat", at(14)), "Good afternoon");
assert.equal(rendererPick(injected.personalized_greeting, "chat", at(20)), "Good evening");
assert.equal(rendererPick(injected.personalized_greeting, "chat", at(23)), "Good evening");

// 2. A configured name is folded into each slot.
const addressed = named.injectPlain({});
assert.equal(rendererPick(addressed.personalized_greeting, "chat", at(6)), "Good morning, Ada");
assert.equal(rendererPick(addressed.personalized_greeting, "chat", at(14)), "Good afternoon, Ada");

// 3. A greeting the upstream did send is left untouched (same object back).
const upstream = {
  personalized_greeting: [{ surface: "chat", default_slots: [{ until: 24, text: "Hi" }] }],
};
assert.equal(bare.inject(upstream), upstream);
// An empty array counts as "not sent" and is filled in.
assert.equal(
  bare.injectPlain({ personalized_greeting: [] }).personalized_greeting[0].surface,
  "chat",
);
// Non-object bodies are passed through rather than throwing.
assert.equal(bare.inject(null), null);
assert.deepEqual(bare.injectPlain([1, 2]), [1, 2]);

// 4. The user-menu identity: Desktop reports the OS app user, the name override
//    wins when set, and an unset name keeps what Desktop reported.
assert.deepEqual(bare.storePlain({ principalDisplayName: "app" }), { principalDisplayName: "app" });
assert.deepEqual(named.storePlain({ principalDisplayName: "app" }), { principalDisplayName: "Ada" });
assert.deepEqual(named.storePlain({}), { principalDisplayName: "Ada" });
assert.deepEqual(bare.storePlain({}), { principalDisplayName: null });

process.stdout.write("greeting-smoke: bootstrap greeting and user-name override behave\n");
