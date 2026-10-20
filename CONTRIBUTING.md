# Contributing to framepass

## Setup

```sh
git clone https://github.com/vladfedorov92/framepass.git
cd framepass
npm install        # also builds dist/
```

Requires Node.js 18 or newer.

| Command | |
|---|---|
| `npm run build` | compile TypeScript into `dist/` |
| `npm test` | build and run the tests (`node:test`) |
| `npm run demo` | two-site demo |

## Layout

```
src/core     shared types, message protocol, capability detection
src/embed    SDK for the iframe
src/host     SDK for the partner site
src/server   Node middleware
src/visit    helper for first-party visit pages
test/        tests
demo/        demo
```

## Demo

```sh
npm run demo
```

1. `http://localhost:4000`: the widget site, sign in there.
2. `http://127.0.0.1:3000`: the partner site with the widget iframe.
3. `http://127.0.0.1:3000/?visit=login`: same, but the widget's login page serves as the first-party visit popup.
4. `http://127.0.0.1:3000/?mode=button`: the widget is only a "Sign in" button in a portal menu (`attachLogin`).

These are different sites, so the widget's cookies are third-party. Chrome Incognito and Firefox
are the easiest to test with. Safari does not accept Secure cookies over http: issue certificates
(e.g. `mkcert host.test widget.test`), add the domains to your hosts file and run:

```sh
FRAMEPASS_CERT=cert.pem FRAMEPASS_KEY=key.pem \
HOST_ORIGIN=https://host.test:3000 WIDGET_ORIGIN=https://widget.test:4000 npm run demo
```

## Pull requests

- `npm test` must pass.
- Cover new behaviour with tests in `test/`.
- If browser behaviour changes, say which browsers and modes you checked with the demo.
- If the public API changes, update the README.

## Releasing (maintainers)

```sh
npm test
npm version patch     # or minor / major: commits and tags
npm publish           # dist/ is built automatically (prepare)
git push --follow-tags
```
