# Деплой

## Домены (Vercel DNS)

| Запись                 | Тип   | Цель                                | Назначение |
|------------------------|-------|-------------------------------------|------------|
| `vtxservices.ru`       | Vercel project | apps/web                    | PWA        |
| `vtxservices.online`   | ALIAS | `<service>.up.railway.app`          | API        |
| `api.vtxservices.online` | CNAME | `<service>.up.railway.app`        | API (резерв; на текущем плане Railway вторая custom‑domain на сервис недоступна) |

## Railway (API)

Проект `vtxservices`: сервисы **api**, **Postgres**, **Redis**.

Переменные окружения сервиса `api` (см. `apps/api/.env.example`):

```
NODE_ENV=production
PORT=8080
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
JWT_SECRET=<32+ случайных байт>
SERVER_SECRET=<32+ случайных байт>          # HMAC подписи кодов MLN-*
ADMIN_2FA_ENC_KEY=<32+ случайных байт>
ADMIN_LOGIN_PATH=/admin-<случайный суффикс>
CORS_ORIGIN=https://vtxservices.ru
API_DOMAIN=vtxservices.online
FIRMWARE_DIR=/data/firmware
UPLOAD_DIR=/data/uploads
```

Сборка: root directory = репозиторий, build `pnpm install --frozen-lockfile && pnpm -r build`,
start `node apps/api/dist/server.js`. Миграции и сид выполняются при старте (`SKIP_MIGRATIONS=1` — отключить).
Для файлов прошивок подключите Volume в `/data`.

## Vercel (Web)

- Root Directory: `apps/web`; Framework: Vite; Build: `pnpm --filter @vtx/web build`; Output: `dist`.
- Env: `VITE_API_URL=https://vtxservices.online`, `VITE_ADMIN_LOGIN_PATH=<как ADMIN_LOGIN_PATH>`.
- SPA rewrite `/(.*) -> /index.html` задан в `apps/web/vercel.json`.

## Проверка после деплоя

```bash
curl https://vtxservices.online/health
curl -I -H 'Origin: https://vtxservices.ru' -X OPTIONS -H 'Access-Control-Request-Method: POST' \
  https://vtxservices.online/api/auth/register        # 204 + Access-Control-Allow-Origin
curl -I -H 'Origin: https://evil.example' -X OPTIONS -H 'Access-Control-Request-Method: POST' \
  https://vtxservices.online/api/auth/register        # 403
```
