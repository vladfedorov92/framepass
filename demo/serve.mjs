// Two cross-site origins for manual testing:
//   host site   (the partner page)  HOST_ORIGIN,   default http://127.0.0.1:3000
//   widget site (embedded iframe)   WIDGET_ORIGIN, default http://localhost:4000
// Safari needs HTTPS: set FRAMEPASS_CERT / FRAMEPASS_KEY (e.g. from mkcert) and https origins.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { framepass, serializeCookie, appendSetCookie, parseCookies } from '../dist/server/index.js';

const HOST_ORIGIN = process.env.HOST_ORIGIN ?? 'http://127.0.0.1:3000';
const WIDGET_ORIGIN = process.env.WIDGET_ORIGIN ?? 'http://localhost:4000';
const root = fileURLToPath(new URL('..', import.meta.url));
const tls = process.env.FRAMEPASS_CERT && process.env.FRAMEPASS_KEY
  ? { cert: await readFile(process.env.FRAMEPASS_CERT), key: await readFile(process.env.FRAMEPASS_KEY) }
  : undefined;

const TYPES = { '.js': 'text/javascript', '.map': 'application/json', '.html': 'text/html; charset=utf-8' };

async function sendFile(res, file, replace = {}) {
  try {
    let body = await readFile(file, 'utf8');
    for (const [k, v] of Object.entries(replace)) body = body.replaceAll(k, v);
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'text/plain');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}

function serveLib(req, res) {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0].slice('/lib/'.length)));
  if (rel.startsWith('..')) return sendFile(res, '');
  return sendFile(res, join(root, 'dist', rel));
}

function listen(origin, handler) {
  const { port, hostname } = new URL(origin);
  const server = tls ? createHttps(tls, handler) : createHttp(handler);
  server.listen(Number(port), hostname === 'localhost' ? undefined : hostname, () => console.log(`  ${origin}`));
}

const vars = { __HOST_ORIGIN__: HOST_ORIGIN, __WIDGET_ORIGIN__: WIDGET_ORIGIN };

// --- host site -------------------------------------------------------------
listen(HOST_ORIGIN, (req, res) => {
  if (req.url.startsWith('/lib/')) return serveLib(req, res);
  return sendFile(res, join(root, 'demo', 'host.html'), vars);
});

// --- widget site -----------------------------------------------------------
// Way 1: a branded visit page; framepass injects its script, the button only needs data-framepass-continue.
const fp = framepass({
  allowedOrigins: [HOST_ORIGIN],
  embedPaths: ['/embed', '/login-button'],
  visitPage: () => readFile(join(root, 'demo', 'visit.html'), 'utf8'),
});

listen(WIDGET_ORIGIN, async (req, res) => {
  if (fp(req, res)) return;
  const path = req.url.split('?')[0];
  const user = parseCookies(req.headers.cookie).demo_session;

  if (path.startsWith('/lib/')) return serveLib(req, res);

  if (path === '/embed') {
    return sendFile(res, join(root, 'demo', 'embed.html'), vars);
  }

  if (path === '/login-button') {
    return sendFile(res, join(root, 'demo', 'login-button.html'), vars);
  }

  if (path === '/api/me') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ user: user ?? null }));
  }

  if (path === '/login' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const name = form.get('name')?.trim() || 'guest';
    // Like a real SSO: go back to the partner page, but only to an allowed origin (no open redirect).
    const back = form.get('return') ?? '';
    const safeBack = back.startsWith(`${HOST_ORIGIN}/`) ? back : '/';
    appendSetCookie(res, serializeCookie('demo_session', name, { httpOnly: true, maxAge: 86400 }));
    res.statusCode = 303;
    res.setHeader('Location', safeBack);
    return res.end();
  }

  if (path === '/logout') {
    appendSetCookie(res, serializeCookie('demo_session', '', { maxAge: 0 }));
    res.statusCode = 303;
    res.setHeader('Location', '/');
    return res.end();
  }

  return sendFile(res, join(root, 'demo', 'widget-home.html'), {
    ...vars,
    __USER__: user ? `Signed in as <b>${user.replace(/[<>&"]/g, '')}</b>. <a href="/logout">Sign out</a>` : 'You are not signed in.',
  });
});

console.log('framepass demo:');
