# 05 — Open Questions & Known Limitations (Post-S61)

## Active tech-debt items

### Medium priority (should fix soon)

| ID | Issue | Module | Notes |
|----|-------|--------|-------|
| D1 | `console.log` in production routes | `deepseek/index.js:35` | Used for auth check logging. Should use logger. |
| D2 | Unused imports in routes.js | `routes.js` | ~37 ESLint warnings. Known tech-debt. |
| D3 | `services/session/` empty directory | — | Created by tokenManager but never populated. Leftover from single-provider era. |
| D4 | `MAX_HISTORY_LENGTH=100` but sliding window triggers at 60 | `chatHistory.js` vs `routes.js` | Two different history limits — may conflict. |
| D5 | Memory Guard срабатывает, но не освобождает память сразу | `pagePool.js` | restartBrowserIfLeaking завершает старый браузер, но RSS остаётся высоким до GC Node.js. |
| D6 | `testToken` в `adminRoutes.js` — вызывает независимый API запрос | `adminRoutes.js` | Тестирование токена через Qwen API — может ошибочно маркировать валидный токен как INVALID при временных сетевых ошибках. |

### Low priority (monitor)

| ID | Issue | Module | Notes |
|----|-------|--------|-------|
| D7 | `Target.closeTarget: Target closed` в error.log | `pagePool.js` | Известно — не критично. safeClosePage подавляет. |
| D8 | Node.js `fetch` может отсутствовать на старых версиях | `qwenApi.js` | Проверка `typeof fetch` не везде. |
| D9 | Browser heap растёт в длинных agent-loop (>100 вызовов) | `browser.js` | PAGE_POOL_SIZE=3 помогает, но старые страницы не GC'ятся пока в массиве. |
| D10 | DeepSeek: нет юнит-тестов | `tests/unit/` | Только Qwen тесты. DeepSeek требует интеграционных тестов с живыми credentials. |
| D11 | `response/thinking_elapsed_secs` event marker не всегда приходит | `proxyPage.js` | DeepSeek иногда пропускает thinking phase marker. SSE парсер справляется, но может быть неполный think-контент. |

## Resolved issues archive

| ID | Issue | Fixed in | Notes |
|----|-------|----------|-------|
| — | `debug-trace.js` broken import | S67 | Dead code deleted. Import path was `./logger/index.js` instead of `../../../shared/logger/index.js`. |
| — | Cross-account "chat not exist" | S53+ | Path 2 now sends `Authorization: Bearer` + localStorage sync. |
| — | Every request created new chat | S53+ | `didCreateChatInternally()` closure + `newChatId` flag. |
| — | JSON artifact stripping (regex bug) | S52+ | Broken regex replaced with `parseToolCallParts()`. |
| — | WAF bypass (Authorization header) | S62 | HAR analysis proved Qwen frontend doesn't send it. Removed. |
| — | PoW WASM solver | S63+ | Pure JS solver (`js-sha3`) replaces .wasm binary. |

## Known behavioral quirks (not bugs, design trade-offs)

### 1. "chat is in progress" not fully eliminated (Qwen only)

Когда два запроса одновременно попадают в один Qwen чат, второй получает `"chat is in progress"`. Proxy retry-механизм (до 3 попыток, ~2s/4s) справляется, но может занять до 10 секунд.

### 2. Model behavior varies by account "memory cleanliness" (Qwen only)

Qwen сохраняет историю на сервере. Если аккаунт использовался для тестов (мусорные чаты), модель может отвечать хуже. Флаг `forceNewChat` сбрасывает контекст.

### 3. Qwen ignores `system_message` on existing chat continuations (Qwen only)

System message применяется только при создании чата. Воркараунд: dual injection — и в первый запрос, и в каждый последующий (через `applyToolPrompt` + префикс в user content).

### 4. OpenWebUI meta-request isolation (both providers)

`isOpenWebUiMetaRequest()` фильтрует фоновые промпты OpenWebUI (`### Task:`, `History:`). Всегда `effectiveChatId = null` — не засоряют основной чат.

## API compatibility notes for external clients (both providers)

### OpenAI-compatible endpoints

Both providers expose standard OpenAI format at `/api/v1/chat/completions`:
- POST with `{ messages, model, stream, tools, tool_choice }`
- SSE for streaming (`text/event-stream`), JSON for non-streaming
- Models list at `/api/v1/models` (GET)

### Headers that affect behavior (Qwen only under `services/qwen/api/routes.js`)

| Header | Effect |
|--------|--------|
| `X-Chat-Id` / `x-chat-id` | Specify existing Qwen chat ID for continuation |
| `X-Parent-Id` / `x-parent-id` | Specify parent message ID for branched conversation |
| `X-New-Chat` / `x-reset-chat: true` | Force create new chat |
| `X-Conversation-Id` / `x-conversation-id` | Scope session to specific conversation |
| `X-Scoped-Session` | Enable scoped session restore |
