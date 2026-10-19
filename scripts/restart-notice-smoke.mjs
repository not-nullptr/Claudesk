// The restart notice's persistence half: what the bridge writes on its way down
// has to survive into the next bridge, and the next bridge has to replay it to
// the pages that reconnect — including the ones whose stream died mid-restart,
// which on a deploy that recreates the Desktop container is all of them. A
// notice whose window closed while the bridge was down must not come back.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNotice, saveNotice } from '../bridge/notices.mjs';
import { createRealtimeController } from '../bridge/realtime.mjs';

const dir = mkdtempSync(join(tmpdir(), 'claudesk-notice-'));
try {
  assert.equal(loadNotice(dir), null, 'an empty state directory holds no notice');

  const now = 1_000_000;
  const record = { title: 'Your VM is restarting', description: 'wait a minute', expiresAt: now + 60_000 };
  saveNotice(dir, record);
  assert.deepEqual(loadNotice(dir, now), record, 'a saved notice must be read back whole');

  assert.equal(loadNotice(dir, now + 60_001), null, 'a notice past its expiry must not be replayed');
  assert.equal(loadNotice(dir, now + 60_001), null, 'and reading it must leave nothing behind');

  writeFileSync(join(dir, 'notice.json'), 'not json');
  assert.equal(loadNotice(dir, now), null, 'a state directory someone else wrote to must not throw');

  writeFileSync(join(dir, 'notice.json'), JSON.stringify({ expiresAt: 'soon' }));
  assert.equal(loadNotice(dir, now), null, 'a record without a real expiry is not a notice');

  // What the next bridge does with it: seed from disk, then hand it to every page
  // that connects. Nobody is connected at startup, so the seed must not depend on
  // a broadcast reaching anyone. Real time here — the controller is not handed a
  // clock the way `loadNotice` is.
  saveNotice(dir, { ...record, expiresAt: Date.now() + 60_000 });
  const chunks = [];
  const controller = createRealtimeController({
    desktop: { async pollEvents() { return []; } },
    isChatSession: () => true,
    ApiError: Error,
  });
  controller.restore(loadNotice(dir));
  const response = { writeHead() {}, on() {}, write(chunk) { chunks.push(chunk); } };
  controller.open({ headers: { "user-agent": "restart-notice-smoke" }, on() {} },
    response, new URL('http://local/api/events'));
  await new Promise((resolve) => setImmediate(resolve));
  const notices = chunks.join('').split('\n\n')
    .filter((frame) => frame.includes('event: notice')).map((frame) => JSON.parse(/data: ([^\n]+)/.exec(frame)[1]));
  assert.deepEqual(notices.map(n => [n.title, n.description]),
    [['Your VM is restarting', 'wait a minute']],
    'a reconnecting page must be served the notice the previous bridge left');

  // ...and a notice already past its expiry is not seeded at all.
  saveNotice(dir, { ...record, expiresAt: Date.now() - 1 });
  const stale = createRealtimeController({
    desktop: { async pollEvents() { return []; } },
    isChatSession: () => true,
    ApiError: Error,
  });
  stale.restore(loadNotice(dir));
  const after = [];
  stale.open({ headers: { "user-agent": "restart-notice-smoke" }, on() {} },
    { writeHead() {}, on() {}, write(chunk) { after.push(chunk); } },
    new URL('http://local/api/events'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(after.join('').includes('event: notice'), false,
    'a notice whose window closed while the bridge was down must not come back');
  console.log('restart-notice-smoke: the notice survives the restart, replays to reconnecting pages and expires');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
