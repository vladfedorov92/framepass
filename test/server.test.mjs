import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { framepass, serializeCookie, parseCookies } from '../dist/server/index.js';

async function withServer(options, fn) {
  const mw = framepass(options);
  const server = createServer((req, res) => {
    if (!mw(req, res)) res.end('app');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(url);
  } finally {
    server.close();
  }
}

test('probe reports access only with the first-party marker', async () => {
  await withServer({ allowedOrigins: [] }, async (url) => {
    const no = await fetch(`${url}/__framepass/probe`);
    assert.deepEqual(await no.json(), { access: false });
    assert.equal(no.headers.get('cache-control'), 'no-store');

    const yes = await fetch(`${url}/__framepass/probe`, { headers: { cookie: '__framepass_fp=1' } });
    assert.deepEqual(await yes.json(), { access: true });
  });
});

test('top-level navigation sets the marker, frame requests do not', async () => {
  await withServer({ allowedOrigins: [] }, async (url) => {
    const top = await fetch(`${url}/`, { headers: { 'sec-fetch-dest': 'document' } });
    assert.match(top.headers.get('set-cookie'), /^__framepass_fp=1; .*HttpOnly; Secure; SameSite=None/);

    const frame = await fetch(`${url}/`, { headers: { 'sec-fetch-dest': 'iframe' } });
    assert.equal(frame.headers.get('set-cookie'), null);
    assert.equal(await frame.text(), 'app');
  });
});

test('inactive storage access from an allowed origin asks for retry', async () => {
  await withServer({ allowedOrigins: ['https://host.example'] }, async (url) => {
    const res = await fetch(`${url}/api`, {
      headers: { 'sec-fetch-storage-access': 'inactive', origin: 'https://host.example' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('activate-storage-access'), 'retry; allowed-origin="https://host.example"');

    const other = await fetch(`${url}/api`, {
      headers: { 'sec-fetch-storage-access': 'inactive', origin: 'https://evil.example' },
    });
    assert.equal(other.status, 200);
    assert.equal(other.headers.get('activate-storage-access'), null);
  });
});

test('active storage access on iframe load keeps it active', async () => {
  await withServer({ allowedOrigins: [] }, async (url) => {
    const res = await fetch(`${url}/embed`, {
      headers: { 'sec-fetch-storage-access': 'active', 'sec-fetch-dest': 'iframe' },
    });
    assert.equal(res.headers.get('activate-storage-access'), 'load');
    assert.match(res.headers.get('vary'), /Sec-Fetch-Storage-Access/);
  });
});

test('visit page escapes texts and posts back to opener', async () => {
  await withServer({ allowedOrigins: [], visitPage: { title: '<x>' } }, async (url) => {
    const html = await (await fetch(`${url}/__framepass/visit`)).text();
    assert.ok(html.includes('&#60;x&#62;'));
    assert.ok(html.includes("kind: 'visited'"));
  });
});

test('cookie helpers', () => {
  assert.equal(
    serializeCookie('s', 'a b', { partitioned: true, maxAge: 60 }),
    's=a%20b; Path=/; Max-Age=60; Secure; SameSite=None; Partitioned',
  );
  assert.deepEqual(parseCookies('a=1; b=x%20y; a=2'), { a: '1', b: 'x y' });
});

test('express-style next is called for unhandled requests', () => {
  const mw = framepass({ allowedOrigins: [] });
  let called = false;
  const res = {
    headers: {},
    getHeader(n) { return this.headers[n.toLowerCase()]; },
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
  };
  mw({ url: '/x', method: 'GET', headers: {} }, res, () => (called = true));
  assert.ok(called);
});
