# Progress — Dev Environment Setup

Date: 2026-02-06
Repo: `~/Consilium/hierarchical-memory`

## Scope
Настроить рабочую dev-среду для `hierarchical-memory` с pipeline:
`dev -> tests -> sync to production -> restart`.

## Plan
- [x] Проверить текущее состояние dev/prod путей
- [x] Проверить git-инициализацию и историю
- [x] Проверить существующие тесты и их запуск
- [x] Нормализовать npm-скрипты для тестов/запуска
- [x] Уточнить и финализировать README (dev, test, deploy)
- [x] Проверить pipeline через `npm test` и `rsync --dry-run`
- [x] Зафиксировать результаты и команды для ежедневного использования

## Done
- Добавлен `progress.md`
- Обновлён `README.md` (requirements, dev run, tests, deploy flow)
- Обновлён корневой `package.json`:
  - `npm test`
  - `npm run test:watch`
  - `npm run dev`
  - `engines.node >=20.18.1`
- Добавлен LLM adapter layer (`scripts/llm-adapter.js`):
  - `HM_LLM_MODE=mock` (offline deterministic)
  - `HM_LLM_MODE=openclaw` (real gateway transport)
- `scripts/trigger-ws.js` переведён на adapter mode (без изменения внешнего CLI)
- Добавлены e2e оффлайн сценарии:
  - `tests/offline-e2e.test.js` (watcher -> L1 -> archive -> CONTEXT + L2 aggregation)
  - `tests/api-smoke.test.js` (dashboard/api на localhost, isolated data)
  - `tests/multiagent-offline.test.js` (3 агента, параллельные watcher-процессы, межагентный диалог, проверка через localhost API)
- Добавлены env overrides для тестового окружения:
  - `HM_DATA_DIR` (изолированный data root)
  - `HM_AGENTS_CONFIG_PATH` (изолированный agents config для web/server)
  - `PORT` для локального API smoke
- Добавлен скрипт:
  - `npm run test:multiagent:offline`

## Verification

### Tests
Command:
```bash
cd ~/Consilium/hierarchical-memory
npm test
```
Result: PASS (`44 passed, 0 failed`)

### Deploy dry-run
Command:
```bash
rsync -av --dry-run \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data' \
  --exclude='*.log' \
  --exclude='tests' \
  ~/Consilium/hierarchical-memory/ ~/clawd/council/hierarchical-memory/
```
Result: SUCCESS (preview list generated, no write errors)

## Next
- При подтверждении: выполнить реальный `rsync` в production и `bash start.sh` в production директории
