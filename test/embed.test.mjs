import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbed, PublicError } from '../dist/embed/index.js';

const HOST = 'https://host.example';
const SELF = 'https://widget.example';

function fakeEnv({ api = true, hasAccess = false, permission = 'prompt', probe = false, grant = true, ancestor = HOST } = {}) {
  const handlers = new Set();
  const parent = { sent: [], postMessage(msg, origin) { this.sent.push({ msg, origin }); } };
  const opened = [];
  const calls = { request: 0, types: [] };
  const window = {
    parent,
    location: { origin: SELF, ancestorOrigins: ancestor ? [].concat(ancestor) : undefined },
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
  assert.equal(await createEmbed({ allowedHosts: [HOST] }, fakeEnv({ api: false }).env).check(), 'unsupported');
  assert.equal(await createEmbed({ allowedHosts: [HOST] }, fakeEnv({ api: false, probe: true }).env).check(), 'not-needed');
});

test('hasStorageAccess true -> not-needed without prompting', async () => {
  const f = fakeEnv({ hasAccess: true });
  assert.equal(await createEmbed({ allowedHosts: [HOST] }, f.env).check(), 'not-needed');
  assert.equal(f.calls.request, 0);
});

test('previously granted permission is re-activated silently', async () => {
  const f = fakeEnv({ permission: 'granted' });
  assert.equal(await createEmbed({ allowedHosts: [HOST] }, f.env).check(), 'granted');
  assert.equal(f.calls.request, 1);
});

test('prompt -> needs-gesture -> request grants', async () => {
  const f = fakeEnv();
  const embed = createEmbed({ allowedHosts: [HOST] }, f.env);
  assert.equal(await embed.check(), 'needs-gesture');
  assert.equal(await embed.request(), 'granted');
});

test('rejection leads to first-party popup, then back to gesture', async () => {
  const f = fakeEnv({ grant: false });
  const embed = createEmbed({ allowedHosts: [HOST] }, f.env);
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
  const embed = createEmbed({ allowedHosts: [HOST], unpartitioned: ['localStorage'] }, f.env);
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

test('no ancestorOrigins (Firefox): no request, no button, until the handshake', async () => {
  const f = fakeEnv({ ancestor: null, permission: 'granted' });
  const embed = createEmbed({ allowedHosts: [HOST] }, f.env);
  assert.equal(await embed.check(), 'waiting-host');
  assert.equal(f.calls.request, 0, 'no silent re-activation for an unknown page');

  const button = { hidden: false, dataset: {}, addEventListener() {}, removeEventListener() {} };
  embed.attach(button);
  assert.equal(button.hidden, true);

  assert.equal(await embed.request(), 'waiting-host');
  assert.equal(f.calls.request, 0);

  f.dispatch({ ns: 'framepass', kind: 'hello' }, 'https://evil.example');
  await tick();
  assert.equal(embed.state, 'waiting-host');

  f.dispatch({ ns: 'framepass', kind: 'hello' });
  await tick();
  await embed.check();
  assert.equal(embed.state, 'granted');
});

test('handshake arriving during a check still unblocks', async () => {
  const f = fakeEnv({ ancestor: null });
  const embed = createEmbed({ allowedHosts: [HOST] }, f.env);
  f.dispatch({ ns: 'framepass', kind: 'hello' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(embed.state, 'needs-gesture');
});

test('method errors are hidden unless public or exposeErrors', async () => {
  const run = async (options) => {
    const f = fakeEnv({ hasAccess: true });
    createEmbed({ allowedHosts: [HOST], ...options }, f.env);
    f.dispatch({ ns: 'framepass', kind: 'hello' });
    f.dispatch({ ns: 'framepass', kind: 'call', id: 1, method: 'boom' });
    for (let i = 0; i < 3; i++) await tick();
    return f.parent.sent.find((s) => s.msg.kind === 'result').msg.error;
  };
  const boom = () => {
    throw new Error('db password=secret');
  };
  assert.equal(await run({ methods: { boom } }), 'framepass: "boom" failed');
  assert.equal(await run({ methods: { boom }, exposeErrors: true }), 'db password=secret');
  assert.equal(
    await run({ methods: { boom: () => { throw new PublicError('Not logged in'); } } }),
    'Not logged in',
  );
});

test('an allowed parent framed by a foreign top-level site is never trusted', async () => {
  const f = fakeEnv({ ancestor: [HOST, 'https://evil.example'], permission: 'granted' });
  const embed = createEmbed({ allowedHosts: [HOST] }, f.env);
  assert.equal(await embed.check(), 'waiting-host');

  f.dispatch({ ns: 'framepass', kind: 'hello' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(embed.state, 'waiting-host');
  assert.equal(await embed.request(), 'waiting-host');
  assert.equal(f.calls.request, 0);
});

test('a fully allowed chain is trusted without a handshake', async () => {
  const OTHER = 'https://portal.example';
  const f = fakeEnv({ ancestor: [HOST, OTHER] });
  assert.equal(await createEmbed({ allowedHosts: [HOST, OTHER] }, f.env).check(), 'needs-gesture');
});

test('masked ("null") ancestors fall back to the handshake', async () => {
  const f = fakeEnv({ ancestor: ['null'] });
  const embed = createEmbed({ allowedHosts: [HOST] }, f.env);
  assert.equal(await embed.check(), 'waiting-host');
  f.dispatch({ ns: 'framepass', kind: 'hello' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(embed.state, 'needs-gesture');
});

function fakeButton() {
  return {
    dataset: {},
    addEventListener(_t, fn) { this.handler = fn; },
    removeEventListener() { this.handler = undefined; },
    click() { this.handler?.({ preventDefault() {} }); },
  };
}
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const events = (f) => f.parent.sent.filter((s) => s.msg.kind === 'event').map((s) => s.msg.name);
const LOGIN = 'https://widget.example/login';

test('attachLogin: silent sign-in when cookies already flow, delivered after the handshake', async () => {
  const f = fakeEnv({ hasAccess: true });
  const embed = createEmbed({ allowedHosts: [HOST] }, f.env);
  const button = fakeButton();
  embed.attachLogin(button, { loginUrl: LOGIN, isSignedIn: async () => true });
  await settle();
  assert.equal(button.dataset.framepassLogin, 'signed-in');
  assert.deepEqual(events(f), [], 'queued until the host says hello');

  f.dispatch({ ns: 'framepass', kind: 'hello' });
  assert.deepEqual(events(f), ['signed-in']);
  assert.equal(f.opened.length, 0);
});

test('attachLogin: silent check never redirects without a click', async () => {
  const f = fakeEnv({ hasAccess: true });
  const embed = createEmbed({ allowedHosts: [HOST] }, f.env);
  const button = fakeButton();
  embed.attachLogin(button, { loginUrl: LOGIN, isSignedIn: async () => false });
  await settle();
  assert.equal(button.dataset.framepassLogin, 'idle');
  assert.equal(f.opened.length, 0);
});

test('attachLogin: click requests access, then reports a visible session', async () => {
  const f = fakeEnv();
  const embed = createEmbed({ allowedHosts: [HOST] }, f.env);
  await embed.check();
  const button = fakeButton();
  embed.attachLogin(button, { loginUrl: LOGIN, isSignedIn: async () => true });

  button.click();
  assert.equal(f.calls.request, 1, 'requestStorageAccess called synchronously in the click');
  await settle();
  assert.equal(button.dataset.framepassLogin, 'signed-in');
  f.dispatch({ ns: 'framepass', kind: 'hello' });
  assert.deepEqual(events(f), ['signed-in']);
});

test('attachLogin: no session after access -> top-level redirect, next click redirects at once', async () => {
  const f = fakeEnv();
  const embed = createEmbed({ allowedHosts: [HOST] }, f.env);
  await embed.check();
  const button = fakeButton();
  embed.attachLogin(button, { loginUrl: LOGIN, isSignedIn: async () => false });

  button.click();
  await settle();
  assert.deepEqual(f.opened, [LOGIN]);
  assert.equal(button.dataset.framepassLogin, 'redirect');

  button.click();
  assert.deepEqual(f.opened, [LOGIN, LOGIN], 'second click navigates synchronously');
  assert.equal(f.calls.request, 1);
});

test('attachLogin: refused access or an unverified page falls back to the redirect', async () => {
  const refused = fakeEnv({ grant: false });
  const a = createEmbed({ allowedHosts: [HOST], firstPartyUrl: null }, refused.env);
  await a.check();
  const b1 = fakeButton();
  a.attachLogin(b1, { loginUrl: LOGIN, isSignedIn: async () => true });
  b1.click();
  await settle();
  assert.deepEqual(refused.opened, [LOGIN]);

  const foreign = fakeEnv({ ancestor: [HOST, 'https://evil.example'] });
  const b = createEmbed({ allowedHosts: [HOST] }, foreign.env);
  await b.check();
  const b2 = fakeButton();
  b.attachLogin(b2, { loginUrl: LOGIN, isSignedIn: async () => true });
  b2.click();
  await settle();
  assert.equal(foreign.calls.request, 0, 'no access request for an unverified page');
  assert.deepEqual(foreign.opened, [LOGIN]);
});
