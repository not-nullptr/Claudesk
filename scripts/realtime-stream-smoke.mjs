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
