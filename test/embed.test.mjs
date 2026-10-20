import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbed } from '../dist/embed/index.js';

const HOST = 'https://host.example';
const SELF = 'https://widget.example';

function fakeEnv({ api = true, hasAccess = false, permission = 'prompt', probe = false, grant = true } = {}) {
  const handlers = new Set();
  const parent = { sent: [], postMessage(msg, origin) { this.sent.push({ msg, origin }); } };
  const opened = [];
  const calls = { request: 0, types: [] };
  const window = {
    parent,
    location: { origin: SELF },
    addEventListener: (_t, fn) => handlers.add(fn),
    removeEventListener: (_t, fn) => handlers.delete(fn),
    open: (url) => opened.push(url),
  };
  const document = api
    ? {
        hasStorageAccess: async () => hasAccess,
        requestStorageAccess(types) {
          calls.request++;
          calls.types.push(types);
          return grant ? Promise.resolve(types ? { localStorage: 'LS' } : undefined) : Promise.reject(new Error('no'));
        },
      }
    : {};
  const navigator = { permissions: { query: async () => ({ state: permission }) } };
  const fetch = async () => ({ ok: true, json: async () => ({ access: probe }) });
  const dispatch = (data, origin = HOST, source = parent) => handlers.forEach((fn) => fn({ data, origin, source }));
  return { env: { window, document, navigator, fetch }, parent, opened, calls, dispatch };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('no API and no cookies -> unsupported; with cookies -> not-needed', async () => {
  assert.equal(await createEmbed({ allowedHosts: [] }, fakeEnv({ api: false }).env).check(), 'unsupported');
  assert.equal(await createEmbed({ allowedHosts: [] }, fakeEnv({ api: false, probe: true }).env).check(), 'not-needed');
});

test('hasStorageAccess true -> not-needed without prompting', async () => {
  const f = fakeEnv({ hasAccess: true });
  assert.equal(await createEmbed({ allowedHosts: [] }, f.env).check(), 'not-needed');
  assert.equal(f.calls.request, 0);
});

test('previously granted permission is re-activated silently', async () => {
  const f = fakeEnv({ permission: 'granted' });
  assert.equal(await createEmbed({ allowedHosts: [] }, f.env).check(), 'granted');
  assert.equal(f.calls.request, 1);
});

test('prompt -> needs-gesture -> request grants', async () => {
  const f = fakeEnv();
  const embed = createEmbed({ allowedHosts: [] }, f.env);
  assert.equal(await embed.check(), 'needs-gesture');
  assert.equal(await embed.request(), 'granted');
});

test('rejection leads to first-party popup, then back to gesture', async () => {
  const f = fakeEnv({ grant: false });
  const embed = createEmbed({ allowedHosts: [] }, f.env);
  await embed.check();
  assert.equal(await embed.request(), 'needs-first-party');
  await embed.request();
  assert.deepEqual(f.opened, ['/__framepass/visit']);

  f.dispatch({ ns: 'framepass', kind: 'visited' }, SELF, {});
  assert.equal(embed.state, 'needs-gesture');
  assert.equal(await embed.request(), 'denied');
});

test('unpartitioned storage requests types and exposes the handle', async () => {
  const f = fakeEnv({ hasAccess: true });
  const embed = createEmbed({ allowedHosts: [], unpartitioned: ['localStorage'] }, f.env);
  assert.equal(await embed.check(), 'needs-gesture');
  await embed.request();
  assert.deepEqual(f.calls.types[0], { cookies: true, localStorage: true });
  assert.equal(embed.storage.localStorage, 'LS');
});

test('handshake and RPC only for allowed hosts', async () => {
  const f = fakeEnv({ hasAccess: true });
  createEmbed({ allowedHosts: [HOST], methods: { add: ({ a, b }) => a + b } }, f.env);
  await tick();

  f.dispatch({ ns: 'framepass', kind: 'hello' }, 'https://evil.example');
  assert.equal(f.parent.sent.length, 0);

  f.dispatch({ ns: 'framepass', kind: 'hello' });
  assert.deepEqual(f.parent.sent.at(-1), { msg: { ns: 'framepass', kind: 'ready', state: 'not-needed' }, origin: HOST });

  f.dispatch({ ns: 'framepass', kind: 'call', id: 1, method: 'add', params: { a: 2, b: 3 } });
  f.dispatch({ ns: 'framepass', kind: 'call', id: 2, method: 'toString' });
  await tick();
  const results = f.parent.sent.filter((s) => s.msg.kind === 'result').map((s) => s.msg);
  assert.deepEqual(results.find((r) => r.id === 1), { ns: 'framepass', kind: 'result', id: 1, ok: true, value: 5 });
  assert.equal(results.find((r) => r.id === 2).ok, false);
});
