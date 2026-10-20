# framepass

[![npm](https://img.shields.io/npm/v/framepass)](https://www.npmjs.com/package/framepass)
[![license](https://img.shields.io/npm/l/framepass)](LICENSE)

Read your own cookies from an iframe embedded on other sites, using the
[Storage Access API](https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API).

framepass is for widgets, chats, players, forms and "sign in" buttons that live in an iframe
on partner sites and need to see the user's session on your domain.

> framepass does **not** bypass browser privacy protections. It asks the browser and the user
> for permission, and handles everything that usually makes that request fail.

- [The problem](#the-problem)
- [Installation](#installation)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [API](#api)
- [Browser support](#browser-support)
- [When access is not available](#when-access-is-not-available)
- [Security](#security)

## The problem

Inside an iframe on someone else's site, your domain's cookies are third-party cookies, and browsers hide them:

| Browser | Normal mode | Private / Incognito |
|---|---|---|
| Chrome / Edge | available | blocked (except `Partitioned`) |
| Firefox | Total Cookie Protection: a separate cookie jar per top-level site | same |
| Safari | blocked (ITP) | blocked |

The Storage Access API lets you ask for access, but it comes with many conditions. The request
must be made from inside the iframe, on a click inside that iframe, synchronously in the handler.
Safari and Firefox also require the user to have visited your site directly before. You need the
right `sandbox` flags, cookies with `SameSite=None; Secure`, and re-activation on every load.
framepass takes care of all of that.

## Installation

```sh
npm install framepass
```

Or the latest code from GitHub:

```sh
npm install github:vladfedorov92/framepass
```

The package ships as ES modules with TypeScript types and has no dependencies.
The server part needs Node.js 18 or newer.

Each part is imported where it runs:

| Import | Runs | What it does |
|---|---|---|
| `framepass/embed` | inside the iframe, on your domain | checks and requests access, drives the button, answers calls |
| `framepass/host` | on the partner site | mounts the iframe and lets the page call its methods |
| `framepass/server` | on your domain's server (Node) | service endpoints, headers, cookie helpers |
| `framepass/visit` | on any page of your site | `notifyVisited()`: turns e.g. your login page into the first-party visit popup |

`framepass/core` exposes the shared types and utilities if you need them directly.

## Quick start

Example: the widget lives on `https://widget.example`, the partner is `https://shop.example`.

### 1. Widget server

```js
import express from 'express';
import { framepass, serializeCookie } from 'framepass/server';

const app = express();

app.use(framepass({
  allowedOrigins: ['https://shop.example'],
  embedPaths: ['/embed'],   // only partners may frame these pages
}));

app.post('/login', (req, res) => {
  // Keep the main site session SameSite=Lax. Give the widget its own limited-scope
  // cookie: only that one is SameSite=None (see "Security").
  res.setHeader('Set-Cookie', [
    serializeCookie('session', createToken(req), { httpOnly: true, sameSite: 'lax' }),
    serializeCookie('widget_session', createWidgetToken(req), { httpOnly: true }),
  ]);
  res.redirect('/');
});

app.get('/embed', (req, res) => res.sendFile('embed.html', { root: 'public' }));
```

The middleware also works with a bare `http.createServer`. Without `next` it returns `true` when it has answered the request:

```js
const fp = framepass({ allowedOrigins: ['https://shop.example'] });

http.createServer((req, res) => {
  if (fp(req, res)) return;
  // ...your routes
});
```

### 2. The iframe page (`/embed`)

```html
<button id="allow" hidden>Allow access</button>

<script type="module">
  import { createEmbed } from 'framepass/embed';

  const embed = createEmbed({
    allowedHosts: ['https://shop.example'],
    methods: {
      getSession: () => fetch('/api/me', { credentials: 'include' }).then((r) => r.json()),
    },
  });

  // the button shows itself when a click is needed and hides once access is there
  embed.attach(document.getElementById('allow'));
  embed.on('change', (state) => console.log('access:', state));
</script>
```

### 3. Partner site

```js
import { mountEmbed } from 'framepass/host';

const widget = mountEmbed('#widget', { src: 'https://widget.example/embed' });

widget.on('state', (state) => console.log('widget access:', state));
const session = await widget.call('getSession');
```

## How it works

```
              check()                            button click
unknown ──────────────┬─► not-needed          ┌─────────────────► granted
                      ├─► granted (silently)  │
                      ├─► needs-gesture ──────┤
                      │                       └─ rejected ─► needs-first-party
                      ├─► waiting-host                         │ click: popup on your site
                      ├─► denied                               ▼
                      └─► unsupported               needs-gesture ─ click ─► granted / denied
```

1. **Check without prompting.** If cookies are already available (e.g. Chrome in normal mode), the state is `not-needed`.
2. **Verify the parent.** Access is only ever requested when the embedding page is one of `allowedHosts`. Until that is confirmed the state is `waiting-host`.
3. **Silent re-activation.** If the user already granted access for this pair of sites, framepass turns it back on without a click.
4. **Button.** Otherwise a button inside the iframe is shown, and its click calls `requestStorageAccess()`.
5. **First-party visit.** Safari and Firefox reject right away if the user has never opened your site directly. The next click then opens a popup on your domain; the user presses "Continue", the popup closes, and one more click in the iframe completes the request.

To know for sure that real (unpartitioned) cookies are reachable, the server sets a marker
cookie on direct visits to your site, and the iframe asks the server whether the marker arrives.

### What the user sees

framepass draws no UI in the iframe or on the partner site: you build the button and hints.
The user sees:

1. **Your button** inside the widget, only when a click is needed.
2. **The browser's own prompt** asking whether to allow cookies. The browser renders it; you cannot change it.
3. **The first-party visit popup**, only in Safari and Firefox and only if the user has not visited your site yet.

### The first-party visit popup

By default it is a simple page at `/__framepass/visit` with a title, a text and a button.
There are three ways to replace it.

**Your own texts:**

```js
framepass({
  allowedOrigins: [...],
  visitPage: { lang: 'en', title: 'Connect the widget', text: '…', button: 'Continue', standalone: 'Done' },
});
```

**Your own page.** A function returns HTML (sync or async). framepass injects
`/__framepass/visit.js`; the button only needs the `data-framepass-continue` attribute:

```js
framepass({
  allowedOrigins: [...],
  visitPage: (req) => renderTemplate('framepass-visit', { locale: req.headers['accept-language'] }),
});
```

```html
<button data-framepass-continue data-framepass-popup>Continue</button>
<p data-framepass-standalone hidden>Done, you can close this tab.</p>
```

| Attribute | |
|---|---|
| `data-framepass-continue` | a click reports the visit to the widget and closes the popup |
| `data-framepass-popup` | visible only when the page was opened by the widget |
| `data-framepass-standalone` | visible only when the page was opened directly |

The script is loaded as an external file, so it works under a strict CSP (`script-src 'self'`).

**Any page of your site**, such as the login page. Signing in then also satisfies the
first-party visit requirement:

```js
// in the iframe
createEmbed({ allowedHosts: [...], firstPartyUrl: '/login?popup=1' });
```

```js
// on /login, after a successful sign-in
import { isVisitPopup, notifyVisited } from 'framepass/visit';

if (isVisitPopup()) {
  backButton.hidden = false;
  backButton.onclick = () => notifyVisited();   // tells the widget and closes the popup
}
```

Safari only counts a visit with a user interaction: a click or a form submission works,
merely opening the page does not.

## API

### `createEmbed(options)` — `framepass/embed`

| Option | Type | Default | |
|---|---|---|---|
| `allowedHosts` | `string[]` | — | origins allowed to embed the iframe and call its methods. Access is only requested on these sites. **Required** |
| `methods` | `Record<string, (params, ctx) => any>` | `{}` | methods for `widget.call()`; `ctx = { state, storage, origin }` |
| `exposeErrors` | `boolean` | `false` | send the real error messages of failed methods to the partner site |
| `unpartitioned` | `StorageType[]` | — | request unpartitioned `localStorage`, `indexedDB`, etc. (Chromium only) |
| `probeUrl` | `string \| null` | `/__framepass/probe` | cookie probe endpoint |
| `firstPartyUrl` | `string \| null` | `/__framepass/visit` | first-party visit page; `null` disables the popup |
| `autoCheck` | `boolean` | `true` | run `check()` right away |

Returns:

| | |
|---|---|
| `state` | current state (see below) |
| `storage` | `StorageAccessHandle` with unpartitioned storage (if requested) |
| `check()` | work out the state without prompting the user |
| `request()` | request access. **Call it synchronously from a click handler inside the iframe** |
| `attach(button)` | bind a button: its click calls `request()`, and `hidden` follows the state. Returns an unbind function |
| `expose(methods)` | add methods |
| `on('change', fn)` | subscribe to state changes; returns an unsubscribe function |
| `destroy()` | remove listeners |

When a method throws, the partner only receives `framepass: "<method>" failed`. To pass a
readable message, throw a `PublicError`:

```js
import { PublicError } from 'framepass/embed';

methods: {
  getSession: async () => {
    const res = await fetch('/api/me', { credentials: 'include' });
    if (res.status === 401) throw new PublicError('Not logged in');
    return res.json();
  },
}
```

### States

| State | Meaning | What to do |
|---|---|---|
| `unknown` | check still running | wait |
| `not-needed` | cookies are already available | nothing |
| `granted` | access granted | nothing |
| `needs-gesture` | a click inside the iframe is needed | show the button (`attach` does it for you) |
| `needs-first-party` | a visit to your site is needed | the next click opens the popup |
| `waiting-host` | a request is needed, but the parent page is not yet verified as one of `allowedHosts` | use `framepass/host` on the partner site; on any other site it stays this way |
| `denied` | refused | offer to retry or a [fallback](#when-access-is-not-available) |
| `unsupported` | no API and no cookie access | a [fallback](#when-access-is-not-available) |

`hasAccess(state)` returns `true` for `not-needed` and `granted`.

### `mountEmbed(target, options)` — `framepass/host`

| Option | Type | |
|---|---|---|
| `src` | `string` | URL of the iframe page. **Required** |
| `sandbox` | `string[]` | when set, framepass appends the tokens it needs; without it the iframe is not sandboxed |
| `title` | `string` | iframe `title` (accessibility) |
| `attributes` | `Record<string, string>` | any extra iframe attributes |
| `timeout` | `number` | `call()` timeout in ms; default 15000 |

Returns `{ iframe, state, ready, call(method, params), on('state', fn), destroy() }`.
Calls made before the iframe is ready are queued.

### `framepass(options)` — `framepass/server`

| Option | Default | |
|---|---|---|
| `allowedOrigins` | — | partner sites, as bare origins (`https://shop.example`, no `/` or `*`). **Required** |
| `embedPaths` | — | pages served into iframes (`'/embed'` matches the page and everything under `/embed/`, or a `RegExp`); they get `frame-ancestors` from `allowedOrigins` |
| `basePath` | `/__framepass` | prefix of the service endpoints |
| `markerCookie` | `__framepass_fp` | marker cookie name |
| `markerMaxAge` | 30 days | marker lifetime, seconds |
| `storageAccessHeaders` | `true` | Storage Access Headers support (Chrome) |
| `visitPage` | English texts | `{ title, text, button, standalone, lang }` or `(req) => html \| Promise<html>`, see [the popup](#the-first-party-visit-popup) |

What the middleware does:
- `GET {basePath}/probe` → `{ "access": boolean }`;
- `GET {basePath}/visit`: the first-party visit page;
- `GET {basePath}/visit.js`: its script;
- sets the marker cookie on direct visits to the site;
- sets `Content-Security-Policy: frame-ancestors` on `embedPaths` and `frame-ancestors 'none'` on the visit page
  (an existing CSP that already has `frame-ancestors` is left alone);
- Storage Access Headers: answers `Sec-Fetch-Storage-Access: inactive` from an allowed site with
  `Activate-Storage-Access: retry`, and an iframe load with `active` with `load`.

Helpers: `serializeCookie(name, value, options)`, `appendSetCookie(res, cookie)`, `parseCookies(header)`,
`injectScript(html, src)`, `frameAncestors(origins)`.
`serializeCookie` validates the name, `path` and `domain` and throws a `TypeError` on `;`, spaces or control characters.
By default it sets `Path=/; Secure; SameSite=None`, plus `Partitioned` with `{ partitioned: true }` ([CHIPS](https://developer.mozilla.org/en-US/docs/Web/Privacy/Privacy_sandbox/Partitioned_cookies)).

### `framepass/visit`

| | |
|---|---|
| `isVisitPopup()` | `true` when the widget opened this page as its first-party visit popup |
| `notifyVisited({ close = true })` | tell the widget about the visit (to your origin only) and close the popup; `false` when the page was not opened by the widget |

## Browser support

| | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Storage Access API | ✓ | ✓ | ✓ |
| Silent re-activation | ✓ | — | — |
| Unpartitioned storage (`unpartitioned`) | ✓ | — | — |
| Storage Access Headers | ✓ | — | — |
| Requires a prior direct visit | — | sometimes | ✓ |

Brave and users with strict settings may refuse anyway; that is expected.

## When access is not available

- **State only matters within one partner site** (a cart, widget settings): use `Partitioned`
  cookies, `serializeCookie('cart', id, { partitioned: true })`. No permission needed at all.
- **You need authentication**: sign in through a popup on your domain, then hand a token to the iframe via `postMessage`.
- **The partner has a backend**: issue a token server-to-server and pass it into the iframe.
- **SSO**: have a look at [FedCM](https://developer.mozilla.org/en-US/docs/Web/API/FedCM_API).

Do not use redirect chains to sync identifiers: browsers' bounce-tracking protections purge them.

## Security

The package has no dependencies and sends data nowhere but your own server. Still, granting
cookie access to a frame on someone else's site widens the attack surface. What framepass
handles and what is up to you:

**framepass handles**
- Access is requested (silently or not) only when the parent page is one of `allowedHosts`.
  This is checked with `location.ancestorOrigins` (Chromium, Safari) or the `framepass/host` handshake,
  so an attacker's site that frames your widget cannot trick the user into granting access (clickjacking).
- `embedPaths` stops other sites from framing your widget pages (`frame-ancestors`), and the
  visit page cannot be framed at all.
- Messages are accepted only from the expected window and origin and sent only to an exact origin.
  Only explicitly declared methods can be called.
- Method error messages do not reach the partner unless `exposeErrors` is on or a `PublicError` is thrown.

**Up to you**
- **CSRF.** A `SameSite=None` cookie is sent with requests from *any* site when the browser allows
  third-party cookies (e.g. Chrome in normal mode). Do not move your main session to `SameSite=None`:
  give the widget its own cookie with minimal rights, and protect every state-changing request with
  an `Origin` header check and/or CSRF tokens.
- **Minimal data in methods.** Whatever a method returns, the partner site receives. Return what the UI
  needs (a name, a status), never tokens or more personal data than necessary.
- **The partner list.** `allowedHosts` and `allowedOrigins` are your trust boundary: exact origins only, no wildcards.
- **The demo** (`demo/`) is for local testing, not a production template.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
