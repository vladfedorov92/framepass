import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_BASE_PATH, NS } from '../core/index.js';

export interface ServerOptions {
  /** Origins allowed to embed us; used for Storage Access Headers. */
  allowedOrigins: string[];
  /** Prefix for the probe and visit endpoints (default `/__framepass`). */
  basePath?: string;
  /** Cookie set on top-level visits; its presence in a frame proves unpartitioned access. */
  markerCookie?: string;
  /** Marker lifetime in seconds (default 30 days, matching browser grant windows). */
  markerMaxAge?: number;
  /** Handle Chromium Storage Access Headers (default true). */
  storageAccessHeaders?: boolean;
  /**
   * The first-party visit page: texts for the built-in one, or a function returning your own HTML.
   * framepass injects `{basePath}/visit.js` into custom HTML; mark the confirming element
   * with `data-framepass-continue`.
   */
  visitPage?: VisitTexts | ((req: IncomingMessage) => string | Promise<string>);
}

export interface VisitTexts {
  title?: string;
  text?: string;
  button?: string;
  /** Shown instead of the button when the page was opened directly, not as a popup. */
  standalone?: string;
  lang?: string;
}

export interface CookieOptions {
  maxAge?: number;
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  /** Defaults to `none`: anything else is never sent in a cross-site frame. */
  sameSite?: 'none' | 'lax' | 'strict';
  /** CHIPS: keep the cookie in a jar keyed by the top-level site. */
  partitioned?: boolean;
}

type Next = (err?: unknown) => void;

/**
 * Connect/Express-style middleware. Without `next` it returns whether it answered the request,
 * so it also fits a bare `http.createServer` handler.
 */
export function framepass(options: ServerOptions) {
  const base = (options.basePath ?? DEFAULT_BASE_PATH).replace(/\/$/, '');
  const marker = options.markerCookie ?? '__framepass_fp';
  const markerMaxAge = options.markerMaxAge ?? 60 * 60 * 24 * 30;
  const allowed = new Set(options.allowedOrigins);
  const sah = options.storageAccessHeaders !== false;

  return function handle(req: IncomingMessage, res: ServerResponse, next?: Next): boolean {
    const path = (req.url ?? '/').split('?')[0];
    const dest = header(req, 'sec-fetch-dest');
    const hasMarker = parseCookies(header(req, 'cookie'))[marker] === '1';

    if (sah) {
      appendVary(res, 'Sec-Fetch-Storage-Access');
      const access = header(req, 'sec-fetch-storage-access');
      const origin = header(req, 'origin');
      if (access === 'inactive' && origin && allowed.has(origin)) {
        // Permission exists but is not active for this request: ask the browser to retry with it on.
        res.statusCode = 401;
        res.setHeader('Activate-Storage-Access', `retry; allowed-origin="${origin}"`);
        res.end();
        return done(next, true);
      }
      if (access === 'active' && dest === 'iframe') {
        // Keep access active in the loaded document, so it needn't call requestStorageAccess().
        res.setHeader('Activate-Storage-Access', 'load');
      }
    }

    if (dest === 'document' && !hasMarker) {
      appendSetCookie(res, serializeCookie(marker, '1', { maxAge: markerMaxAge, httpOnly: true }));
    }

    if (req.method === 'GET' && path === `${base}/probe`) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ access: hasMarker }));
      return done(next, true);
    }

    if (req.method === 'GET' && path === `${base}/visit.js`) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(VISIT_SCRIPT);
      return done(next, true);
    }

    if (req.method === 'GET' && path === `${base}/visit`) {
      const page = options.visitPage;
      const send = (html: string) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(html);
      };
      if (typeof page !== 'function') {
        send(defaultVisitPage(page, base));
        return done(next, true);
      }
      Promise.resolve()
        .then(() => page(req))
        .then(
          (html) => send(injectScript(html, `${base}/visit.js`)),
          (err) => {
            if (next) return next(err);
            res.statusCode = 500;
            res.end();
          },
        );
      return true;
    }

    return done(next, false);
  };
}

function done(next: Next | undefined, handled: boolean): boolean {
  if (!handled && next) next();
  return handled;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const sameSite = options.sameSite ?? 'none';
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly) parts.push('HttpOnly');
  parts.push('Secure', `SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1)}`);
  if (options.partitioned) parts.push('Partitioned');
  return parts.join('; ');
}

export function appendSetCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader('Set-Cookie');
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev : [String(prev)];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

export function parseCookies(headerValue: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (headerValue ?? '').split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const key = pair.slice(0, i).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(pair.slice(i + 1).trim());
    } catch {
      out[key] = pair.slice(i + 1).trim();
    }
  }
  return out;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function appendVary(res: ServerResponse, value: string) {
  const prev = res.getHeader('Vary');
  res.setHeader('Vary', prev ? `${String(prev)}, ${value}` : value);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Served at `{basePath}/visit.js`; external so pages with `script-src 'self'` still work.
 * Clicking `[data-framepass-continue]` reports the visit to the frame that opened the popup.
 * `[data-framepass-popup]` / `[data-framepass-standalone]` are shown only with / without an opener.
 */
export const VISIT_SCRIPT = `(function () {
  function done() {
    if (!window.opener) return false;
    window.opener.postMessage({ ns: ${JSON.stringify(NS)}, kind: 'visited' }, location.origin);
    window.close();
    return true;
  }
  window.framepass = Object.assign(window.framepass || {}, { done: done });
  document.addEventListener('click', function (e) {
    var el = e.target instanceof Element && e.target.closest('[data-framepass-continue]');
    if (el && done()) e.preventDefault();
  });
  function toggle() {
    var popup = !!window.opener;
    document.querySelectorAll('[data-framepass-popup]').forEach(function (el) { el.hidden = !popup; });
    document.querySelectorAll('[data-framepass-standalone]').forEach(function (el) { el.hidden = popup; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', toggle);
  else toggle();
})();
`;

/** Adds `<script src>` before the last `</body>`, or at the end when there is none. */
export function injectScript(html: string, src: string): string {
  const tag = `<script src="${escapeHtml(src)}"></script>`;
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i < 0 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

function defaultVisitPage(texts: VisitTexts = {}, base: string): string {
  const title = escapeHtml(texts.title ?? 'Allow access');
  const text = escapeHtml(texts.text ?? 'Continue to let this site work inside the pages that embed it.');
  const button = escapeHtml(texts.button ?? 'Continue');
  const standalone = escapeHtml(texts.standalone ?? 'Done. You can close this tab.');
  const lang = escapeHtml(texts.lang ?? 'en');
  // A real click on our own top-level page is what Safari counts as user interaction.
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}</style>
</head><body><h1>${title}</h1><p>${text}</p>
<button type="button" data-framepass-continue data-framepass-popup>${button}</button>
<p data-framepass-standalone hidden>${standalone}</p>
<script src="${escapeHtml(base)}/visit.js"></script>
</body></html>`;
}
