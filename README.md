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
| `framepass/visit` | на любой странице вашего сайта | `notifyVisited()` — сделать, например, страницу входа окном первого визита |

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

### Что видит пользователь

framepass не рисует интерфейс в iframe и на сайте-партнёре: кнопку и подсказки делаете вы.
Пользователь увидит:

1. **Вашу кнопку** внутри виджета — только когда нужен клик.
2. **Системный диалог браузера** с вопросом, разрешить ли куки. Его рисует браузер, и изменить его нельзя.
3. **Окно первого визита** — только в Safari и Firefox и только если пользователь ещё не бывал на вашем сайте.

### Окно первого визита

По умолчанию это простая страница `/__framepass/visit` с заголовком, текстом и кнопкой.
Её можно заменить тремя способами.

**Свои тексты:**

```js
framepass({
  allowedOrigins: [...],
  visitPage: { lang: 'ru', title: 'Подключить виджет', text: '…', button: 'Продолжить', standalone: 'Готово' },
});
```

**Своя страница.** Функция возвращает HTML (можно асинхронно). framepass сам подключит
`/__framepass/visit.js`, а кнопке достаточно атрибута `data-framepass-continue`:

```js
framepass({
  allowedOrigins: [...],
  visitPage: (req) => renderTemplate('framepass-visit', { locale: req.headers['accept-language'] }),
});
```

```html
<button data-framepass-continue data-framepass-popup>Продолжить</button>
<p data-framepass-standalone hidden>Готово, вкладку можно закрыть.</p>
```

| Атрибут | |
|---|---|
| `data-framepass-continue` | клик сообщает виджету о визите и закрывает окно |
| `data-framepass-popup` | виден, только если страница открыта виджетом |
| `data-framepass-standalone` | виден, только если страницу открыли напрямую |

Скрипт подключается внешним файлом, поэтому работает и со строгой CSP (`script-src 'self'`).

**Любая страница вашего сайта**, например страница входа. Пользователь входит и тем же действием
выполняет условие первого визита:

```js
// в iframe
createEmbed({ allowedHosts: [...], firstPartyUrl: '/login?popup=1' });
```

```js
// на странице /login, после успешного входа
import { isVisitPopup, notifyVisited } from 'framepass/visit';

if (isVisitPopup()) {
  backButton.hidden = false;
  backButton.onclick = () => notifyVisited();   // сообщит виджету и закроет окно
}
```

Safari засчитывает визит только с действием пользователя: клик или отправка формы подходят,
простое открытие страницы — нет.

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
| `visitPage` | англ. тексты | `{ title, text, button, standalone, lang }` или `(req) => html \| Promise<html>` — см. [Окно первого визита](#окно-первого-визита) |

Что делает middleware:
- `GET {basePath}/probe` → `{ "access": boolean }`;
- `GET {basePath}/visit` — страница первого визита;
- `GET {basePath}/visit.js` — её скрипт;
- ставит маркер-куку при прямом заходе на сайт;
- Storage Access Headers: на `Sec-Fetch-Storage-Access: inactive` от разрешённого сайта
  отвечает `Activate-Storage-Access: retry`, при загрузке iframe с `active` — `load`.

Хелперы: `serializeCookie(name, value, options)`, `appendSetCookie(res, cookie)`, `parseCookies(header)`,
`injectScript(html, src)`.
`serializeCookie` по умолчанию ставит `Path=/; Secure; SameSite=None`, а с `{ partitioned: true }` — ещё и `Partitioned` ([CHIPS](https://developer.mozilla.org/en-US/docs/Web/Privacy/Privacy_sandbox/Partitioned_cookies)).

### `framepass/visit`

| | |
|---|---|
| `isVisitPopup()` | `true`, если страницу открыл виджет как окно первого визита |
| `notifyVisited({ close = true })` | сообщить виджету о визите (только на ваш origin) и закрыть окно; `false`, если окно открыто не виджетом |

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

## Лицензия

MIT
