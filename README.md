# VTX Services

Платформа для прошивки и настройки полётных контроллеров (INAV 7) и пультов
RadioMaster (прошивка `<Пульт>_VtxAuto_v3.1`): автоопределение VTX, сетки частот,
diff‑система, AutoFlash, эмуляторы, подписки и коды активации.

- Frontend (PWA): https://vtxservices.ru — `apps/web` (Vite + React + TypeScript)
- API: https://vtxservices.online — `apps/api` (Fastify 5 + Drizzle + PostgreSQL + Redis)
- Общий MSP/MSP2‑клиент и эмулятор FC — `packages/msp` (`@vtx/msp`)

## Структура

```
apps/api        Fastify API: auth+fingerprint, подписки/коды MLN-*, устройства, каталог
                прошивок/моделей/VTX, diff, AutoFlash, realtime (WS), admin (TOTP), CMS
apps/web        PWA: Connect (Web Serial), AutoDetectVTXWizard, AutoFlash, Diff,
                эмуляторы пульта/борта, SubmissionWizard, кабинет, админка
packages/msp    MSP v1/v2 (CRC8-DVB-S2), retry 100 ms, лог, Web Serial transport,
                LoopbackTransport + EmulatedFc, кастомные MSP2 0x2F10..0x2F22, парсер vtx_info
docs/           документация (деплой, протокол, прошивки)
```

## Локальный запуск

Требуется Node 22, pnpm 9, Docker (PostgreSQL 16, Redis 7).

```bash
pnpm install
docker run -d --name vtxpg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vtx -p 5432:5432 postgres:16
docker run -d --name vtxredis -p 6379:6379 redis:7
cp apps/api/.env.example apps/api/.env      # при необходимости поправьте
pnpm --filter @vtx/api dev                  # миграции + сид выполняются на старте
pnpm --filter @vtx/web dev                  # http://localhost:5173, прокси /api -> :8080
```

Проверки: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

## Протокол MSP2 (кастом INAV)

| Код    | Назначение                                   |
|--------|----------------------------------------------|
| 0x2F10 | VTX_MAP_READ — прочитать карту RC‑уровень→частота |
| 0x2F11 | VTX_MAP_WRITE — записать карту (до 16 пар)   |
| 0x2F12 | VTX_MAP_SET — записать одну пару             |
| 0x2F13 | VTX_MAP_LIVE — применить частоту по RC‑уровню |
| 0x2F20 | GET_UID — UID MCU                            |
| 0x2F21 | SET_AUTH_TOKEN — токен авторизации пульта    |
| 0x2F22 | GET_AUTH_STATUS — статус подписки на FC      |

CLI: `vtx_info` — тип VTX (SmartAudio/Tramp), сетка bands×channels, частоты.

## Деплой

См. `docs/deploy.md`.
