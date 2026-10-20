import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { framepass, serializeCookie, parseCookies, injectScript, frameAncestors } from '../dist/server/index.js';

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

test('built-in visit page escapes texts and loads the visit script', async () => {
  await withServer({ allowedOrigins: [], visitPage: { title: '<x>' } }, async (url) => {
    const html = await (await fetch(`${url}/__framepass/visit`)).text();
    assert.ok(html.includes('&#60;x&#62;'));
    assert.ok(html.includes('<script src="/__framepass/visit.js"></script>'));
    assert.ok(html.includes('data-framepass-continue'));
  });
});

test('visit script is served as external JS', async () => {
  await withServer({ allowedOrigins: [] }, async (url) => {
    const res = await fetch(`${url}/__framepass/visit.js`);
    assert.match(res.headers.get('content-type'), /^text\/javascript/);
    const js = await res.text();
    assert.ok(js.includes("kind: 'visited'"));
    assert.ok(js.includes('[data-framepass-continue]'));
  });
});

test('custom visit page gets the script injected before </body>', async () => {
  const visitPage = async (req) => `<html><body><h1>Brand ${req.url}</h1><a data-framepass-continue>Go</a></BODY></html>`;
  await withServer({ allowedOrigins: [], basePath: '/fp', visitPage }, async (url) => {
    const html = await (await fetch(`${url}/fp/visit`)).text();
    assert.equal(
      html,
      '<html><body><h1>Brand /fp/visit</h1><a data-framepass-continue>Go</a><script src="/fp/visit.js"></script></BODY></html>',
    );
  });
});

test('failing custom visit page answers 500', async () => {
  const visitPage = () => {
    throw new Error('boom');
  };
  await withServer({ allowedOrigins: [], visitPage }, async (url) => {
    assert.equal((await fetch(`${url}/__framepass/visit`)).status, 500);
  });
});

test('injectScript appends when there is no body', () => {
  assert.equal(injectScript('<p>hi</p>', '/v.js'), '<p>hi</p><script src="/v.js"></script>');
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

test('embed paths get frame-ancestors, visit page cannot be framed', async () => {
  const options = { allowedOrigins: ['https://a.example', 'https://b.example'], embedPaths: ['/embed', /^\/w\d+$/] };
  await withServer(options, async (url) => {
    const csp = async (p) => (await fetch(url + p)).headers.get('content-security-policy');
    assert.equal(await csp('/embed'), 'frame-ancestors https://a.example https://b.example');
    assert.equal(await csp('/embed/x'), 'frame-ancestors https://a.example https://b.example');
    assert.equal(await csp('/w42'), 'frame-ancestors https://a.example https://b.example');
    assert.equal(await csp('/embedded'), null);
    assert.equal(await csp('/__framepass/visit'), "frame-ancestors 'none'");
  });
});

test('allowedOrigins must be bare origins', () => {
  assert.throws(() => framepass({ allowedOrigins: ['https://a.example/'] }), /not an origin/);
  assert.throws(() => framepass({ allowedOrigins: ['https://a.example; script-src *'] }), /not an origin/);
  assert.throws(() => framepass({ allowedOrigins: ['*'] }), /not an origin/);
  assert.equal(frameAncestors([]), "frame-ancestors 'none'");
});

test('serializeCookie rejects attribute injection', () => {
  assert.throws(() => serializeCookie('a;b', 'x'), /cookie name/);
  assert.throws(() => serializeCookie('s', 'x', { path: '/; Domain=evil.example' }), /cookie path/);
  assert.throws(() => serializeCookie('s', 'x', { domain: 'a.example\r\nX: y' }), /cookie domain/);
  assert.throws(() => serializeCookie('s', 'x', { maxAge: Infinity }), /maxAge/);
  assert.equal(serializeCookie('s', 'a;b'), 's=a%3Bb; Path=/; Secure; SameSite=None');
});
