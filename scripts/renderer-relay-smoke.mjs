import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../bridge-wrapper/main.cjs', import.meta.url), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
const received = [], registered = new Set(), callbacks = new Map();
let views = [
  { id: 1, type: 'window', url: 'app://localhost/shell' },
  { id: 2, type: 'browserView', url: 'app://localhost/index.html' },
  { id: 3, type: 'window', url: 'https://claude.ai/' },
];
for (const view of views) {
  view.isDestroyed = () => !!view.destroyed;
  view.getURL = () => view.url;
  view.getType = () => view.type;
  const sandbox = { console: { debug(message) { relay.enqueueRelayedEvent(JSON.parse(message.slice('relay:'.length)), view.id); } },
    'claude.web': { LocalAgentModeSessions: { onOnEvent(callback) { callbacks.set(view.id, callback); return () => {}; } } } };
  vm.createContext(sandbox);
  view.executeJavaScript = async expression => vm.runInContext(expression, sandbox);
}
const sandbox = {
  webContents: { getAllWebContents: () => views, fromId: id => views.find(view => view.id === id) },
  registeredRelayContentsIds: registered, attachRelayConsole() {},
  relayedListeners: new Map([['LocalAgentModeSessions', new Set(['onOnEvent'])]]),
  relayConsolePrefix: 'relay:', rendererReadyTimeoutMs: 100, rendererReadyPollMs: 1,
  wait: async () => {},
};
vm.createContext(sandbox);
const relay = { relayedListeners: sandbox.relayedListeners, relayedEventQueue: received,
  relayedEventCopies: new Map(), relayedEventCopiesBytes: 0,
  Date: { now: () => now } };
let now = 10000;
vm.createContext(relay);
vm.runInContext(section('function enqueueRelayedEvent(', 'function attachRelayConsole('), relay);
vm.runInContext(section('function rendererCandidates()', 'async function evaluateInOfficialRenderer(')
  + section('async function ensureRelayedEventsRegistered()', 'async function drainRelayedEvents('), sandbox);
await sandbox.ensureRelayedEventsRegistered();
assert.deepEqual([...registered], [1, 2], 'embedded app views must register alongside the shell window');
assert.equal(callbacks.has(3), false, 'external origins must not be injected');
const original = callbacks.get(2);
await sandbox.ensureRelayedEventsRegistered();
assert.equal(callbacks.get(2), original, 'polling must not duplicate subscriptions');
for (const text of ['turn one', 'turn two']) callbacks.get(2)({ type: 'message', sessionId: 'session', message: { text } });
assert.deepEqual(received.map(event => event.payload.message.text), ['turn one', 'turn two']);
const broadcast = {type:'message',sessionId:'session',message:{type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking'}}}};
for (const callback of callbacks.values()) callback(broadcast);
assert.equal(received.length, 3, 'a block-start broadcast is delivered once across renderers');
const repeated = {type:'message',sessionId:'session',message:{type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'ha'}}}};
for(let occurrence=0;occurrence<3;occurrence++)for(const callback of callbacks.values())callback(repeated);
assert.equal(received.length, 6, 'three identical deltas remain three, not one or six');
callbacks.get(1)({type:'message',sessionId:'shell-only',message:{text:'shell turn'}});
callbacks.get(2)({type:'message',sessionId:'view-only',message:{text:'view turn'}});
assert.deepEqual(received.slice(-2).map(e=>e.payload.sessionId), ['shell-only','view-only'],
  'events routed only to either renderer must reach the browser');
now += 2600;
callbacks.get(2)(repeated);
assert.equal(received.length, 9, 'deduplication expires');
for(let i=0;i<2100;i++)relay.enqueueRelayedEvent({surface:'LocalAgentModeSessions',method:'onOnEvent',payload:{i}},1);
assert.ok(relay.relayedEventCopies.size<=2000, 'deduplication cache is bounded');
assert.ok(relay.relayedEventCopiesBytes<=8*1024*1024);
relay.enqueueRelayedEvent({surface:'LocalAgentModeSessions',method:'onOnEvent',payload:{text:'x'.repeat(40000)}},1);
assert.ok(relay.relayedEventCopies.size<=2000, 'large events bypass the deduplication cache');
views[1].destroyed = true;
await sandbox.ensureRelayedEventsRegistered();
assert.equal(registered.has(2), false);
console.log('renderer-relay-smoke: embedded views stream, shell and external origins are handled, subscriptions are not duplicated');
