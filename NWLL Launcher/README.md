# Orbit — лаунчер приложений

Лёгкий русскоязычный каталог приложений с поиском, категориями и сохраняемой в браузере библиотекой.

## Запуск

Для OAuth нужен Node.js сервер (статический `python -m http.server` не обрабатывает callback). Скопируйте `.env.example` в `.env`, вставьте туда новый Google Client Secret после его ротации, Discord Client ID/Secret и задайте длинный случайный `SESSION_SECRET`. Запустите сервер:

```powershell
node server.js
```

Затем откройте `http://localhost:4173`. Добавленные приложения и библиотека хранятся в `localStorage` этого браузера. Кнопка «Открыть» ведёт на официальный сайт приложения.

## Запуск через Windows EXE

В папке проекта есть `OrbitLauncher.exe`. Он проверяет локальный сервер, при необходимости запускает `node server.js` в отдельном окне и открывает лаунчер в браузере по умолчанию. Оставь EXE рядом с `server.js`, `index.html`, остальными файлами проекта и локальным `.env`. Требуется установленный Node.js. Это небольшая Windows-оболочка для запуска, а не самостоятельный инсталлятор; OAuth продолжает работать в обычном браузере.

## Вход через Google и Discord

Вход Google реализован в `server.js`. Чтобы проверить его локально:

1. В Google Cloud Console добавьте Authorized redirect URI `http://localhost:4173/auth/callback/google`.
2. Для production добавьте Authorized redirect URI `https://nightwell.fun/auth/callback/google` и настройте reverse proxy, чтобы запросы `/auth/*` и `/api/*` попадали в Node.js сервер. Страница лаунчера может оставаться в `/NWLL%20Launcher/`; OAuth endpoint намеренно находится на корне домена.
3. На сервере задайте `GOOGLE_REDIRECT_URI=https://nightwell.fun/auth/callback/google`. Значение должно в точности совпадать с адресом в Google Console.
4. В `.env` задайте новый `GOOGLE_CLIENT_SECRET` и `SESSION_SECRET`. `.env` исключён из Git.

В Google Console `https://nightwell.fun` в Authorized JavaScript origins указано верно. Старый redirect URI `https://nightwell.fun/NWLL%20Launcher/` можно оставить, но новый серверный callback нужно добавить отдельной строкой. Секреты провайдера нельзя помещать в `config.js`.

### Discord

1. Открой [Discord Developer Portal](https://discord.com/developers/applications), создай application и открой вкладку OAuth2.
2. Добавь redirect URI `http://localhost:4173/auth/callback/discord` для локальной проверки и `https://nightwell.fun/auth/callback/discord` для production. OAuth требует точного совпадения URL.
3. Скопируй Application ID и Client Secret в `DISCORD_CLIENT_ID` и `DISCORD_CLIENT_SECRET` в локальный `.env`. Не помещай Client Secret в `config.js` и не публикуй его.
4. Локально используй `DISCORD_REDIRECT_URI=http://localhost:4173/auth/callback/discord`. Для production укажи `https://nightwell.fun/auth/callback/discord` и направь `/auth/*` и `/api/*` через HTTPS reverse proxy на Node.js сервер.

Сервер запрашивает только `identify` и `email`, сверяет `state`, обменивает authorization code на access token и получает профиль пользователя через Discord API. Реализация следует [Discord OAuth2 Authorization Code Grant](https://discord.com/developers/docs/topics/oauth2).

## О текущем каталоге

Встроенный каталог демонстрационный. Он открывает официальные веб-версии приложений; установка нативных программ на устройство требует desktop-оболочки и проверенных установочных пакетов/манифестов.
