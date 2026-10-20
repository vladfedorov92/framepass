# Участие в разработке framepass

## Подготовка

```sh
git clone https://github.com/vladfedorov92/framepass.git
cd framepass
npm install        # заодно собирает dist/
```

Нужен Node.js 18 или новее.

| Команда | |
|---|---|
| `npm run build` | сборка TypeScript в `dist/` |
| `npm test` | сборка и тесты (`node:test`) |
| `npm run demo` | демо-стенд на двух сайтах |

## Структура

```
src/core     общие типы, протокол сообщений, определение возможностей
src/embed    SDK для iframe
src/host     SDK для сайта-партнёра
src/server   Node middleware
src/visit    хелпер для страниц первого визита
test/        тесты
demo/        демо-стенд
```

## Демо

```sh
npm run demo
```

1. `http://localhost:4000` — сайт виджета, войдите на нём.
2. `http://127.0.0.1:3000` — сайт-партнёр с iframe виджета.
3. `http://127.0.0.1:3000/?visit=login` — то же, но окном первого визита служит страница входа виджета.

Это разные сайты, поэтому куки виджета считаются сторонними. Удобнее всего проверять в
Chrome Incognito и Firefox. Safari не принимает Secure-куки по http: выпустите сертификаты
(например, `mkcert host.test widget.test`), пропишите домены в hosts и запустите:

```sh
FRAMEPASS_CERT=cert.pem FRAMEPASS_KEY=key.pem \
HOST_ORIGIN=https://host.test:3000 WIDGET_ORIGIN=https://widget.test:4000 npm run demo
```

## Pull request

- Перед отправкой должен проходить `npm test`.
- Новое поведение покрывайте тестами в `test/`.
- Если меняется поведение в браузере, опишите, в каких браузерах и режимах вы проверяли его через демо.
- Меняется публичный API — обновите README.

## Публикация (для мейнтейнеров)

```sh
npm test
npm version patch     # или minor / major — коммит и тег
npm publish           # dist/ собирается автоматически (prepare)
git push --follow-tags
```
