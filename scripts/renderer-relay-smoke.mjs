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
  const sandbox = { console: { debug(message) { received.push(JSON.parse(message.slice('relay:'.length))); } },
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
views[1].destroyed = true;
await sandbox.ensureRelayedEventsRegistered();
assert.equal(registered.has(2), false);
console.log('renderer-relay-smoke: embedded views stream, shell and external origins are handled, subscriptions are not duplicated');
