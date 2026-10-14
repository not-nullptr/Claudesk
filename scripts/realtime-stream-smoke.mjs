import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRealtimeController } from '../bridge/realtime.mjs';
let now = 100000, running = true, activity = 1, reads = 0, queue = [], duringRead;
const realNow = Date.now;
Date.now = () => now;
const desktop = {
  async invoke(surface, method) {
    assert.equal(surface, 'LocalAgentModeSessions');
    if (method === 'getAll') return [{ sessionId: 'session', isRunning: running, lastActivityAt: activity }];
    assert.equal(method, 'getTranscript'); reads++;
    const snapshot = [{ uuid: 'first', text: 'Hi! What can I help you with' }];
    if (duringRead) { duringRead(); duringRead = undefined; }
    return snapshot;
  },
  async pollEvents() { const events = queue; queue = []; return events; },
};
const chunks = [];
const request = { on() {} };
const response = { writeHead() {}, on() {}, write(chunk) { chunks.push(chunk); } };
const controller = createRealtimeController({ desktop, isChatSession: () => true, ApiError: Error });
const events = () => chunks.join('').split('\n\n').filter(s => s.includes('event:')).map(s => ({
  type: /event: ([^\n]+)/.exec(s)[1], data: JSON.parse(/data: ([^\n]+)/.exec(s)[1]),
}));
const native = payload => ({ surface: 'LocalAgentModeSessions', method: 'onOnEvent', payload: { sessionId: 'session', ...payload } });
const settle = () => new Promise(resolve => setImmediate(resolve));
try {
  controller.open(request, response, new URL('http://local/api/events?sessionId=session'));
  await settle();
  for (const text of ['today?', 'Yes, I can search.', 'Web search is erroring.']) {
    queue.push(native({ type: 'message', message: { type: 'stream_event', delta: text } }));
    await controller.pollDesktopEvents(); await controller.pollState(); now += 2000;
  }
  assert.equal(reads, 0, 'active streaming must never read/replace a disk transcript');
  assert.equal(events().filter(e => e.type === 'desktop-ipc').length, 3);
  assert.equal(events().filter(e => e.type === 'transcript').length, 0);
  running = false; activity++;
  duringRead = () => { running = true; activity++; queue.push(native({ type: 'start' })); };
  await controller.pollState();
  assert.equal(events().filter(e => e.type === 'transcript').length, 0,
    'a turn starting during snapshot read must discard the stale snapshot');
  running = false; activity++; now += 2000;
  queue.push(native({ type: 'close' }));
  await controller.pollState();
  assert.equal(events().filter(e => e.type === 'transcript').length, 0,
    'terminal events must settle before an idle snapshot');
  now += 2000; await controller.pollState();
  assert.equal(events().filter(e => e.type === 'transcript').length, 1);
  assert.equal(events().filter(e => e.type === 'desktop-ipc' && e.data.payload.type === 'close').length, 1);
  assert.equal(events().at(-1).data.isRunning, false);
  // The restart notice: broadcast to whoever is connected, and replayed to a
  // page that connects while it is still live — a tab opened mid-restart has to
  // hear it too — while an expired one is not replayed to every tab after.
  controller.notify({ title: 'Your VM is restarting', description: 'wait' });
  assert.equal(events().filter(e => e.type === 'notice').length, 1);
  assert.deepEqual(events().at(-1).data, { title: 'Your VM is restarting', description: 'wait' });
  const late = { writeHead() {}, on() {}, write(chunk) { chunks.push(chunk); } };
  controller.open(request, late, new URL('http://local/api/events'));
  await settle();
  assert.equal(events().filter(e => e.type === 'notice').length, 2,
    'a page connecting during the window must still receive the notice');
  now += 6 * 60 * 1000;
  const stale = { writeHead() {}, on() {}, write(chunk) { chunks.push(chunk); } };
  controller.open(request, stale, new URL('http://local/api/events'));
  await settle();
  assert.equal(events().filter(e => e.type === 'notice').length, 2,
    'an expired notice must not greet every tab opened afterwards');
  console.log('realtime-stream-smoke: native deltas preserved, active/racing snapshots suppressed, idle reconciliation retained');
} finally { Date.now = realNow; }
const preload = await readFile(new URL('../bridge/public/remote-preload.js', import.meta.url), 'utf8');
const start = preload.indexOf('events.addEventListener("transcript",');
const end = preload.indexOf('\n    });', start) + 8;
let handler;
const delivered = [];
vm.runInNewContext(preload.slice(start, end), {
  events: { addEventListener(name, fn) { handler = fn; } },
  latestTranscriptEvents: new Map(),
  dispatch(surface, method, payload) { delivered.push(payload); },
});
for (const isRunning of [true, false]) handler({ data: JSON.stringify({ sessionId: 'session', value: [], isRunning }) });
assert.deepEqual(delivered.map(event => event.type), ['transcript_loaded'],
  'browser ignores live snapshots and never invents close events');
// The notice event, wired to the toast publish.
const noticeStart = preload.indexOf('events.addEventListener("notice",');
const noticeEnd = preload.indexOf('\n    });', noticeStart) + 8;
let noticeHandler;
const notices = [];
vm.runInNewContext(preload.slice(noticeStart, noticeEnd), {
  events: { addEventListener(name, fn) { noticeHandler = fn; } },
  showNotice(payload) { notices.push(payload); },
});
noticeHandler({ data: JSON.stringify({ title: 'Your VM is restarting', description: 'wait' }) });
assert.deepEqual(notices.map(n => [n.title, n.description]), [['Your VM is restarting', 'wait']],
  'a notice event must be parsed and handed to the toast publish');
// The publish itself: the app's toast when the renderer patch has published one,
// and a single console warning — never a throw on the event stream — when the
// renderer is older than the patch.
const noticeSource = preload.slice(
  preload.indexOf('  let noticeRenderWarned'),
  preload.indexOf('  for (const method of ["pushState"'));
const added = [];
const warnings = [];
vm.runInNewContext(`${noticeSource}\nshowNotice({title:"T",description:"D"});`, {
  globalThis: { __CLAUDESK_TOAST__: { add: (options) => added.push(options) } },
  console: { warn: (message) => warnings.push(message) },
});
assert.deepEqual(added.map(o => [o.title, o.description, o.timeout]), [['T', 'D', 0]],
  'the notice must reach the app toast as a sticky card');
assert.equal(warnings.length, 0);
vm.runInNewContext(`${noticeSource}\nshowNotice({title:"T"});showNotice({title:"T"});`, {
  globalThis: {},
  console: { warn: (message) => warnings.push(message) },
});
assert.equal(warnings.length, 1, 'a renderer without the toast publish must warn once and never throw');
console.log('realtime-stream-smoke: restart notice broadcast, replayed while live, and rendered as a sticky app toast');
