# framepass

Доступ к своим кукам из iframe, встроенного на чужие сайты, через
[Storage Access API](https://developer.mozilla.org/ru/docs/Web/API/Storage_Access_API).

framepass для тех, у кого есть виджет, чат, плеер, форма или кнопка «войти»,
которые живут в iframe на сайтах партнёров и должны видеть сессию пользователя
на вашем домене.

> framepass **не обходит** защиту браузеров. Он честно запрашивает разрешение
> у браузера и пользователя и берёт на себя всё, из-за чего этот запрос обычно не срабатывает.

- [Проблема](#проблема)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Как это работает](#как-это-работает)
- [API](#api)
- [Поддержка браузеров](#поддержка-браузеров)
- [Если доступа нет](#если-доступа-нет)
- [Работа с проектом](#работа-с-проектом)

## Проблема

Куки вашего домена внутри iframe на чужом сайте — сторонние, и браузеры их прячут:

| Браузер | Обычный режим | Инкогнито |
|---|---|---|
| Chrome / Edge | доступны | заблокированы (кроме `Partitioned`) |
| Firefox | Total Cookie Protection: свой «карман» кук на каждый сайт | то же |
| Safari | заблокированы (ITP) | заблокированы |

Storage Access API позволяет попросить доступ, но у него много условий. Запрос
делается только из iframe и только по клику внутри него, причём синхронно в
обработчике. В Safari и Firefox пользователь должен до этого хоть раз открыть ваш
сайт напрямую. Нужны правильный `sandbox`, куки с `SameSite=None; Secure` и повторная
активация при каждой загрузке. framepass выполняет все эти условия.

## Установка

```sh
npm install framepass
```

Пока пакет не опубликован в npm, его можно поставить прямо с GitHub:

```sh
npm install github:vladfedorov92/framepass
```

Пакет поставляется как ES-модули с типами TypeScript и без зависимостей.
Серверной части нужен Node.js 18 или новее.

Пакет состоит из трёх частей, каждая подключается там, где нужна:

| Импорт | Где работает | Что делает |
|---|---|---|
| `framepass/embed` | внутри iframe, на вашем домене | проверяет и запрашивает доступ, управляет кнопкой, отвечает на вызовы |
| `framepass/host` | на сайте-партнёре | вставляет iframe и даёт вызывать его методы |
| `framepass/server` | на сервере вашего домена (Node) | служебные эндпоинты, заголовки, хелперы для кук |

`framepass/core` содержит общие типы и утилиты, если они понадобятся напрямую.

## Быстрый старт

Пример: виджет живёт на `https://widget.example`, партнёр — `https://shop.example`.

### 1. Сервер виджета

```js
import express from 'express';
import { framepass, serializeCookie } from 'framepass/server';

const app = express();

app.use(framepass({ allowedOrigins: ['https://shop.example'] }));

app.post('/login', (req, res) => {
  // сессионная кука должна быть SameSite=None; Secure — хелпер ставит это по умолчанию
  res.setHeader('Set-Cookie', serializeCookie('session', createToken(req), { httpOnly: true }));
  res.redirect('/');
});

app.get('/embed', (req, res) => {
  res.setHeader('Content-Security-Policy', 'frame-ancestors https://shop.example');
  res.sendFile('embed.html', { root: 'public' });
});
```

Middleware работает и с голым `http.createServer`. Без `next` он возвращает `true`, если сам ответил на запрос:

```js
http.createServer((req, res) => {
  if (fp(req, res)) return;
  // ...ваши маршруты
});
```

### 2. Страница iframe (`/embed`)

```html
<button id="allow" hidden>Разрешить доступ</button>

<script type="module">
  import { createEmbed } from 'framepass/embed';

  const embed = createEmbed({
    allowedHosts: ['https://shop.example'],
    methods: {
      getSession: () => fetch('/api/me', { credentials: 'include' }).then((r) => r.json()),
    },
  });

  // кнопка сама показывается, когда нужен клик, и прячется, когда доступ есть
  embed.attach(document.getElementById('allow'));
  embed.on('change', (state) => console.log('access:', state));
</script>
```

### 3. Сайт-партнёр

```js
import { mountEmbed } from 'framepass/host';

const widget = mountEmbed('#widget', { src: 'https://widget.example/embed' });

widget.on('state', (state) => console.log('widget access:', state));
const session = await widget.call('getSession');
```

## Как это работает

```
              check()                         клик по кнопке
unknown ──────────────┬─► not-needed          ┌─────────────────► granted
                      ├─► granted (молча)     │
                      ├─► needs-gesture ──────┤
                      │                       └─ отказ ─► needs-first-party
                      ├─► denied                            │ клик: popup на вашем сайте
                      └─► unsupported                       ▼
                                                     needs-gesture ─ клик ─► granted / denied
```

1. **Проверка без запроса.** Если куки уже доступны (например, обычный режим Chrome), состояние будет `not-needed`.
2. **Тихая повторная активация.** Если пользователь уже разрешал доступ этой паре сайтов, framepass включает его снова без клика.
3. **Кнопка.** Иначе показывается кнопка внутри iframe, а по клику вызывается `requestStorageAccess()`.
4. **Первый визит.** Safari и Firefox сразу отказывают, если пользователь ни разу не открывал ваш сайт напрямую. Тогда следующий клик откроет всплывающее окно на вашем домене. Пользователь нажимает «Продолжить», окно закрывается, и снова нужен клик в iframe.

Чтобы точно знать, доступны ли настоящие куки, сервер ставит маркер-куку при прямом
визите на ваш сайт. Iframe спрашивает у сервера, долетает ли маркер.

## API

### `createEmbed(options)` — `framepass/embed`

| Опция | Тип | По умолчанию | |
|---|---|---|---|
| `allowedHosts` | `string[]` | — | origin'ы, которым можно встраивать iframe и вызывать методы. **Обязательно** |
| `methods` | `Record<string, (params, ctx) => any>` | `{}` | методы для `widget.call()`; `ctx = { state, storage, origin }` |
| `unpartitioned` | `StorageType[]` | — | запросить неразделённые `localStorage`, `indexedDB` и т. п. (только Chromium) |
| `probeUrl` | `string \| null` | `/__framepass/probe` | эндпоинт проверки кук |
| `firstPartyUrl` | `string \| null` | `/__framepass/visit` | страница первого визита; `null` отключает всплывающее окно |
| `autoCheck` | `boolean` | `true` | запустить `check()` сразу |

Возвращает объект:

| | |
|---|---|
| `state` | текущее состояние (см. ниже) |
| `storage` | `StorageAccessHandle` с неразделёнными хранилищами (если запрашивались) |
| `check()` | определить состояние без запроса пользователю |
| `request()` | запросить доступ. **Вызывать синхронно в обработчике клика внутри iframe** |
| `attach(button)` | привязать кнопку: клик вызывает `request()`, а `hidden` выставляется по состоянию. Возвращает функцию отвязки |
| `expose(methods)` | добавить методы |
| `on('change', fn)` | подписка на смену состояния; возвращает отписку |
| `destroy()` | снять обработчики |

### Состояния

| Состояние | Что значит | Что делать |
|---|---|---|
| `unknown` | проверка ещё идёт | ждать |
| `not-needed` | куки и так доступны | ничего |
| `granted` | доступ получен | ничего |
| `needs-gesture` | нужен клик в iframe | показать кнопку (`attach` делает это сам) |
| `needs-first-party` | нужен визит на ваш сайт | следующий клик откроет всплывающее окно |
| `denied` | отказ | можно предложить ещё раз или [запасной путь](#если-доступа-нет) |
| `unsupported` | API нет, куки недоступны | [запасной путь](#если-доступа-нет) |

`hasAccess(state)` возвращает `true` для `not-needed` и `granted`.

### `mountEmbed(target, options)` — `framepass/host`

| Опция | Тип | |
|---|---|---|
| `src` | `string` | адрес страницы iframe. **Обязательно** |
| `sandbox` | `string[]` | если указать, framepass добавит нужные ему токены; без опции iframe не сэндбоксится |
| `title` | `string` | `title` iframe (для доступности) |
| `attributes` | `Record<string, string>` | любые атрибуты iframe |
| `timeout` | `number` | таймаут `call()`, мс; по умолчанию 15000 |

Возвращает `{ iframe, state, ready, call(method, params), on('state', fn), destroy() }`.
Вызовы `call()` до готовности iframe ставятся в очередь.

### `framepass(options)` — `framepass/server`

| Опция | По умолчанию | |
|---|---|---|
| `allowedOrigins` | — | сайты-партнёры. **Обязательно** |
| `basePath` | `/__framepass` | префикс служебных эндпоинтов |
| `markerCookie` | `__framepass_fp` | имя маркер-куки |
| `markerMaxAge` | 30 дней | срок жизни маркера, секунды |
| `storageAccessHeaders` | `true` | поддержка Storage Access Headers (Chrome) |
| `visitPage` | англ. тексты | `{ title, text, button, lang }` страницы первого визита |

Что делает middleware:
- `GET {basePath}/probe` → `{ "access": boolean }`;
- `GET {basePath}/visit` — страница первого визита;
- ставит маркер-куку при прямом заходе на сайт;
- Storage Access Headers: на `Sec-Fetch-Storage-Access: inactive` от разрешённого сайта
  отвечает `Activate-Storage-Access: retry`, при загрузке iframe с `active` — `load`.

Хелперы: `serializeCookie(name, value, options)`, `appendSetCookie(res, cookie)`, `parseCookies(header)`.
`serializeCookie` по умолчанию ставит `Path=/; Secure; SameSite=None`, а с `{ partitioned: true }` — ещё и `Partitioned` ([CHIPS](https://developer.mozilla.org/en-US/docs/Web/Privacy/Privacy_sandbox/Partitioned_cookies)).

## Поддержка браузеров

| | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Storage Access API | ✓ | ✓ | ✓ |
| Тихая повторная активация | ✓ | — | — |
| Неразделённое хранилище (`unpartitioned`) | ✓ | — | — |
| Storage Access Headers | ✓ | — | — |
| Требует прямого визита на сайт | — | иногда | ✓ |

Brave и пользователи со строгими настройками могут отказать в любом случае: это ожидаемо.

## Если доступа нет

- **Состояние нужно только внутри одного сайта-партнёра** (корзина, настройки виджета) — используйте
  `Partitioned`-куки: `serializeCookie('cart', id, { partitioned: true })`. Разрешение вообще не нужно.
- **Нужна авторизация** — вход во всплывающем окне на вашем домене, затем передача токена в iframe через `postMessage`.
- **Есть сервер у партнёра** — выдавайте токен с сервера на сервер и передавайте его в iframe.
- **SSO** — посмотрите на [FedCM](https://developer.mozilla.org/en-US/docs/Web/API/FedCM_API).

Не используйте цепочки редиректов для синхронизации идентификаторов: защиты от bounce tracking в браузерах их вычищают.

## Работа с проектом

```sh
git clone https://github.com/vladfedorov92/framepass.git
cd framepass
npm install        # заодно собирает dist/
```

| Команда | |
|---|---|
| `npm run build` | сборка TypeScript в `dist/` |
| `npm test` | сборка и тесты (`node:test`) |
| `npm run demo` | демо-стенд на двух сайтах |

Структура:

```
src/core     общие типы, протокол сообщений, определение возможностей
src/embed    SDK для iframe
src/host     SDK для сайта-партнёра
src/server   Node middleware
test/        тесты
demo/        демо-стенд
```

### Демо

```sh
npm run demo
```

1. `http://localhost:4000` — сайт виджета, войдите на нём.
2. `http://127.0.0.1:3000` — сайт-партнёр с iframe виджета.

Это разные сайты, поэтому куки виджета считаются сторонними. Удобнее всего проверять в
Chrome Incognito и Firefox. Safari не принимает Secure-куки по http: выпустите сертификаты
(например, `mkcert host.test widget.test`), пропишите домены в hosts и запустите:

```sh
FRAMEPASS_CERT=cert.pem FRAMEPASS_KEY=key.pem \
HOST_ORIGIN=https://host.test:3000 WIDGET_ORIGIN=https://widget.test:4000 npm run demo
```

### Публикация

```sh
npm test
npm version patch     # или minor / major — коммит и тег
npm publish           # dist/ собирается автоматически (prepare)
git push --follow-tags
```

## Лицензия

MIT
