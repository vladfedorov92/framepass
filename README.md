# framepass

Пропуск для iframe: чтение «своих» кук из встроенного на чужой сайт фрейма через
[Storage Access API](https://developer.mozilla.org/ru/docs/Web/API/Storage_Access_API) —
со всеми его подводными камнями, упакованными в один сценарий.

> framepass **не обходит** блокировку сторонних кук. Он честно просит разрешение у браузера
> и пользователя и делает это так, чтобы оно получалось с первого раза.

## Зачем

| Браузер | Обычный режим | Инкогнито |
|---|---|---|
| Chrome / Edge | сторонние куки доступны | блокируются (кроме `Partitioned`) |
| Firefox | Total Cookie Protection: свой «карман» на каждый сайт верхнего уровня | то же |
| Safari | ITP: заблокированы | заблокированы |

Голый Storage Access API требует: вызова изнутри iframe, клика пользователя именно в iframe,
синхронного вызова в обработчике, предварительного визита на ваш сайт (Safari/Firefox),
правильного `sandbox`, `SameSite=None; Secure`, повторной активации при каждой загрузке.
framepass закрывает всё это.

## Устройство

```
framepass/embed   — внутри iframe на вашем домене: проверка, запрос, кнопка, RPC
framepass/host    — на сайте-партнёре: монтирует iframe, мост postMessage
framepass/server  — Node middleware: проба кук, страница первого визита, Storage Access Headers
framepass/core    — состояния, протокол, определение возможностей
```

### Состояния

```
unknown ─┬─ not-needed          куки и так доступны
         ├─ granted             доступ выдан (в т.ч. молча — если разрешение уже было)
         ├─ needs-gesture       нужна кнопка в iframe
         ├─ needs-first-party   нужен визит на ваш сайт (popup), потом снова кнопка
         ├─ denied              отказ
         └─ unsupported         API нет — используйте запасной путь
```

## Использование

**Внутри iframe** (`https://widget.example/embed`):

```js
import { createEmbed } from 'framepass/embed';

const embed = createEmbed({
  allowedHosts: ['https://shop.example'],          // кто может встраивать и звать методы
  unpartitioned: ['localStorage'],                  // опционально, только Chromium
  methods: {
    getSession: async () => (await fetch('/api/me', { credentials: 'include' })).json(),
  },
});

embed.attach(document.querySelector('#allow'));    // кнопка сама прячется/показывается
embed.on('change', (state) => render(state));
```

**На сайте-партнёре**:

```js
import { mountEmbed } from 'framepass/host';

const widget = mountEmbed('#slot', { src: 'https://widget.example/embed' });
widget.on('state', (s) => console.log(s));
const session = await widget.call('getSession');
```

**На сервере виджета** (Express, Connect или голый `http`):

```js
import { framepass, serializeCookie } from 'framepass/server';

app.use(framepass({ allowedOrigins: ['https://shop.example'] }));

// куки сессии — обязательно SameSite=None; Secure (это дефолт хелпера)
res.setHeader('Set-Cookie', serializeCookie('session', token, { httpOnly: true }));
// состояние, нужное только внутри одного сайта-партнёра, — CHIPS:
res.setHeader('Set-Cookie', serializeCookie('cart', id, { partitioned: true }));
```

Middleware:
- ставит маркер-куку `__framepass_fp` при визите на ваш сайт верхнего уровня; если она
  долетает из iframe — значит, доступ к неразделённым кукам есть;
- `GET /__framepass/probe` → `{ access: boolean }`;
- `GET /__framepass/visit` — страница «первого визита» для Safari/Firefox (открывается во всплывающем окне);
- Storage Access Headers (Chrome): на `Sec-Fetch-Storage-Access: inactive` отвечает
  `Activate-Storage-Access: retry`, на загрузку iframe с `active` — `load`.

## Демо

```sh
npm install
npm run demo
```

- `http://localhost:4000` — сайт виджета: войдите (ставится `demo_session`).
- `http://127.0.0.1:3000` — сайт-партнёр с iframe виджета.

Это разные сайты, поэтому браузер считает куки виджета сторонними. Проверяйте в Chrome Incognito и Firefox.
Safari не даёт Secure-куки по http: выпустите сертификаты (например, `mkcert host.test widget.test`),
пропишите домены в hosts и запустите:

```sh
FRAMEPASS_CERT=cert.pem FRAMEPASS_KEY=key.pem \
HOST_ORIGIN=https://host.test:3000 WIDGET_ORIGIN=https://widget.test:4000 npm run demo
```

## Ограничения и запасные пути

- Разрешение выдаётся на пару (ваш сайт, сайт-партнёр) и истекает (~30 дней в Chrome).
- Brave и пользователи с жёсткими настройками всё равно откажут — это ожидаемо.
- Если `unsupported`/`denied`: popup-логин на вашем домене → токен в iframe через `postMessage`;
  либо токен через сервер партнёра; для SSO смотрите FedCM.
- Не используйте редирект-цепочки для синхронизации идентификаторов — их чистят защиты от bounce tracking.

## Разработка

```sh
npm test     # сборка + node:test
```
