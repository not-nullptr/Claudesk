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
       inject: (value, name, now) => injectPersonalizedGreeting(value, name, now),
       resolve: resolveGreetingName,
       weekIndex: greetingWeekIndex,
       goldenHour: GREETING_GOLDEN_HOUR,
       legacyCandidates: legacyChatGreetingCandidates,
       renderText: greetingText,
       store: (value) => sanitizeStoreValue("LocalAgentModeSessions", "interactiveAuthStore", value),
       bootstrapPath: bootstrapResponsePath,
     };`,
    sandbox,
  );
  const { inject, resolve, weekIndex, goldenHour, legacyCandidates, renderText, store, bootstrapPath }
    = sandbox.result;
  // Round-trip through this realm's JSON so strict deepEqual (which also
  // compares prototypes) sees main-realm objects.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return {
    inject: (value, name, now) => inject(value, name, now),
    injectPlain: (value, name, now) => plain(inject(value, name, now)),
    resolve,
    weekIndex,
    goldenHour,
    legacyCandidates,
    renderText,
    bootstrapPath,
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
const referenceDate = new Date("2026-01-05T12:00:00.000Z"); // Monday, ISO week 2
const nextWeekDate = new Date(referenceDate.getTime() + 7 * 24 * 60 * 60 * 1000);
const sameWeekDate = new Date(referenceDate.getTime() + 6 * 24 * 60 * 60 * 1000);

// 1. An empty upstream bootstrap gets both official surfaces, and every hour of
//    every weekday resolves to some greeting text.
const injected = bare.injectPlain({ account: { uuid: "u" } }, "", referenceDate);
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

// 2. The fixed per-day copy and legacy client strings both belong to the pool.
//    The selector rotates through that pool weekly but is stable on reload.
const sameWeek = bare.injectPlain({}, "", sameWeekDate);
const nextWeek = bare.injectPlain({}, "", nextWeekDate);
assert.deepEqual(sameWeek.personalized_greeting, injected.personalized_greeting,
  "all slots stay stable within an ISO week");
const chatWeek = (greeting) => greeting.find(({ surface }) => surface === "chat");
const nextChatWeek = chatWeek(nextWeek.personalized_greeting);
const currentChatWeek = chatWeek(injected.personalized_greeting);
assert.deepEqual(
  nextWeek.personalized_greeting.find(({ surface }) => surface === "code"),
  injected.personalized_greeting.find(({ surface }) => surface === "code"),
  "the pasted client snippet does not change the Code surface",
);
for (let day = 0; day < currentChatWeek.days.length; day += 1) {
  const currentSlots = currentChatWeek.days[day].slots;
  const nextSlots = nextChatWeek.days[day].slots;
  assert.equal(currentSlots.length, nextSlots.length, "weekly slot boundaries stay stable");
  for (let slot = 0; slot < currentSlots.length; slot += 1) {
    assert.notEqual(currentSlots[slot].text, nextSlots[slot].text,
      `${currentChatWeek.days[day].day} greeting changes at slot ending ${currentSlots[slot].until}`);
  }
}
for (let slot = 0; slot < currentChatWeek.default_slots.length; slot += 1) {
  assert.notEqual(currentChatWeek.default_slots[slot].text, nextChatWeek.default_slots[slot].text,
    `default Chat greeting changes at slot ending ${currentChatWeek.default_slots[slot].until}`);
}
let previousWeek = injected.personalized_greeting;
for (let week = 1; week <= 52; week += 1) {
  const date = new Date(referenceDate.getTime() + week * 7 * 24 * 60 * 60 * 1000);
  const currentWeek = bare.injectPlain({}, "", date).personalized_greeting;
  const previousChat = chatWeek(previousWeek);
  const currentChat = chatWeek(currentWeek);
  for (let day = 0; day < previousChat.days.length; day += 1) {
    for (let slot = 0; slot < previousChat.days[day].slots.length; slot += 1) {
      assert.notEqual(previousChat.days[day].slots[slot].text, currentChat.days[day].slots[slot].text,
        `Chat copy rotates every week (${previousChat.days[day].day}, ending ${previousChat.days[day].slots[slot].until})`);
    }
  }
  for (let slot = 0; slot < previousChat.default_slots.length; slot += 1) {
    assert.notEqual(previousChat.default_slots[slot].text, currentChat.default_slots[slot].text,
      `default Chat copy rotates every week (ending ${previousChat.default_slots[slot].until})`);
  }
  previousWeek = currentWeek;
}
assert.equal(pick(injected.personalized_greeting, "code", 6, 0), "Ready when you are"); // sun <12
assert.equal(pick(injected.personalized_greeting, "code", 6, 1), "Morning"); // mon <12
assert.equal(pick(injected.personalized_greeting, "code", 6, 4), "Clean slate"); // thu -> default_slots <12

const legacyCopy = new Set();
for (const day of dayNames) {
  for (const [from, until] of [[0, 5], [5, 9], [9, 12], [12, 16], [16, 18], [18, 24]]) {
    for (const hasName of [false, true]) {
      for (const text of bare.legacyCandidates(day, from, until, hasName, bare.goldenHour)) {
        legacyCopy.add(text);
      }
    }
  }
}
for (const text of [
  "Good morning", "Good morning, {{ NAME }}",
  "Happy Monday", "Happy Monday, {{ NAME }}",
  "Happy Thursday", "Happy Thursday, {{ NAME }}",
  "Happy Friday", "Happy Friday, {{ NAME }}",
  "Welcome to the weekend", "Welcome to the weekend, {{ NAME }}",
  "Happy Saturday!", "Happy Saturday, {{ NAME }}",
  "Sunday session?", "Sunday session, {{ NAME }}?",
  "Happy Sunday", "Happy Sunday, {{ NAME }}",
  "It's late-night", "It's late-night {{ NAME }}", "Golden hour thinking", "Back at it!",
]) {
  assert.ok(legacyCopy.has(text), `legacy pool includes ${text}`);
}
for (const excluded of ["Let’s chat incognito", "Greetings, whoever you are", "You’re incognito"]) {
  assert.ok(!JSON.stringify(injected.personalized_greeting).includes(excluded),
    `${excluded} remains excluded from non-incognito fallback`);
}
assert.ok(serverSource.includes("New week, {{ NAME }}"), "the supplied Chat greeting remains in the pool");
assert.equal(bare.weekIndex(referenceDate), bare.weekIndex(sameWeekDate));
assert.equal(bare.weekIndex(nextWeekDate), bare.weekIndex(referenceDate) + 1);
assert.deepEqual(JSON.parse(JSON.stringify(bare.goldenHour)), { start: 16, end: 18 },
  "the golden-hour window is the legacy late-afternoon one");
assert.ok(bare.legacyCandidates("mon", 16, 18, true, bare.goldenHour)
  .includes("Golden hour thinking"));
assert.ok(!bare.legacyCandidates("mon", 12, 16, true, bare.goldenHour)
  .includes("Golden hour thinking"));
assert.ok(!bare.legacyCandidates("mon", 18, 22, true, bare.goldenHour)
  .includes("Golden hour thinking"));

// 3. A resolved name is expanded into slots that carry the token, and the token
//    never leaks; fixed name-free copy remains available alongside it.
const addressed = named.injectPlain({}, "Ada", referenceDate);
const mondayNamed = pick(addressed.personalized_greeting, "chat", 6, 1);
assert.ok(["New week, Ada", "Good morning, Ada", "Welcome, Ada", "Hey there, Ada",
  "Happy Monday, Ada", "Coffee and Claude time?"].includes(mondayNamed));
assert.equal(pick(addressed.personalized_greeting, "code", 6, 1), "Morning, Ada"); // code unchanged
assert.equal(pick(addressed.personalized_greeting, "code", 14, 4), "Back at it, Ada"); // default_slots
assert.ok(!JSON.stringify(addressed).includes("{{"));

// 4. With no name at all, the token is dropped without stray punctuation.
assert.equal(bare.renderText("Up late, {{ NAME }}?", ""), "Up late?");
assert.equal(bare.renderText("{{ NAME }} returns!", ""), "Returns!");
assert.ok(!JSON.stringify(injected).includes("Maddie"), "the fallback keeps names dynamic");
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
const asApp = bare.injectPlain({ account: { display_name: "Maddie" } }, "app", referenceDate);
assert.ok(["New week, app", "Good morning, app", "Welcome, app", "Hey there, app",
  "Happy Monday, app", "Coffee and Claude time?"].includes(
  pick(asApp.personalized_greeting, "chat", 6, 1),
), "the app-reported name is rendered in the selected Chat greeting");

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

// 7. The bootstrap path matcher accepts both prefixes ion-dist recognizes: the
//    Desktop frame's /edge-api and the plain browser (web shell) app's default
//    /api. It must not match the entitlements document, so the greeting is never
//    injected into that shape.
for (const path of [
  "/edge-api/bootstrap",
  "/edge-api/bootstrap/00000000-0000-0000-0000-000000000000/app_start",
  "/api/bootstrap",
  "/api/bootstrap/00000000-0000-0000-0000-000000000000/app_start",
]) {
  assert.ok(bare.bootstrapPath.test(path), `greeting path matches ${path}`);
}
assert.ok(
  !bare.bootstrapPath.test("/api/bootstrap/00000000-0000-0000-0000-000000000000/current_user_access"),
  "greeting path does not match the entitlements document",
);
assert.ok(!bare.bootstrapPath.test("/api/bootstrap/device"), "greeting path does not match /device");

// 8. The caller must capture the document injectPersonalizedGreeting returns.
//    It builds a new object (unlike the in-place grant* helpers), so the old
//    shape — `if (injectPersonalizedGreeting(parsed, name) !== parsed) rewrote`
//    — set the rewrite flag but still serialized the original, dropping the
//    greeting on every response (Web shell regression, fixed here).
assert.ok(
  serverSource.includes("parsed = injected"),
  "forwardOfficialProtocol must apply the returned greeting document",
);
assert.ok(
  !/injectPersonalizedGreeting\(parsed, name\) !== parsed\)\s*rewrote/.test(serverSource),
  "the greeting document must not be discarded after it is built",
);

// 9. The user-menu identity: Desktop reports the OS app user, the name override
//    wins when set, and an unset name keeps what Desktop reported.
assert.deepEqual(bare.storePlain({ principalDisplayName: "app" }), { principalDisplayName: "app" });
assert.deepEqual(named.storePlain({ principalDisplayName: "app" }), { principalDisplayName: "Ada" });
assert.deepEqual(named.storePlain({}), { principalDisplayName: "Ada" });
assert.deepEqual(bare.storePlain({}), { principalDisplayName: null });

process.stdout.write("greeting-smoke: bootstrap greeting and user-name override behave\n");
