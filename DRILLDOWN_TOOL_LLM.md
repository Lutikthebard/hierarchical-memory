# Drilldown Search Tool (LLM Usage)

## Цель
Быстро найти релевантный memory-артефакт агента и, при необходимости, провалиться в детали (source artifacts или исходные сообщения).

## Минимальный flow (рекомендуется)
1. Поиск:
`GET /api/agents/:agentId/artifacts/search?q=<query>&limit=5`
2. Если есть результат:
`GET /api/agents/:agentId/artifacts/:artifactId/drilldown`

## Как вызывать
- `agentId` обязателен (например, `main` или `council-psychologist`).
- `q` — короткий запрос 2-8 слов.
- `limit` обычно `3..10`.
- Если нужен только уровень L1/L2: добавь `level=1` или `level=2`.

## Что возвращает API
- `/artifacts/search`:
  - `results[]`: `artifactId`, `level`, `startTimestamp`, `endTimestamp`, `snippet`
- `/artifacts/:artifactId/drilldown`:
  - для L1: `messages[]` (архивные сообщения)
  - для L2+: `sourceArtifacts[]` (артефакты предыдущего уровня)

## Как получать CONTEXT.md агента
- Быстро получить текущее содержимое:
  - `GET /api/agents/:agentId/context`
- Получить максимально актуальную версию (рекомендуется перед важным ответом):
  1. `POST /api/agents/:agentId/context/rebuild`
  2. `GET /api/agents/:agentId/context`
- Используй поле `content` из ответа `/context`.

## Правила для LLM
- Если `results` пустой: уточни запрос и повтори поиск.
- Всегда показывай пользователю `snippet` + период времени (`startTimestamp..endTimestamp`).
- Делай drilldown только для 1-2 лучших результатов, чтобы не раздувать контекст.
- Если найден L2 и нужен фактаж: сначала drilldown в L1, потом при необходимости в `messages`.
