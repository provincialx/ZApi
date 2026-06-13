# 04 — Changelog

## Anti-loop detection fixed + cross-turn repeat guard (2026-06-14)

- **`openaiUtils.js`** — Fixed `_allToolResultSignatures()` (was `_currentToolResultSignatures`):
  - **Баг: детекция повторов никогда не работала.** Tool-результаты от Zed не содержат поле `name`, только `tool_call_id`. Старая функция искала `msgs[i].name` → `undefined` → сигнатура `null` → анти-луп гард всегда пропускал повторы.
  - Заменил на матчинг по `tool_call_id` (из assistant.tool_calls → tool.tool_call_id), что гарантирует нахождение имени вызванной функции.
  - Заменил проверку только последнего оборота на сканирование ВСЕЙ истории — теперь ловит многошаговые циклы (read_file A → read_file B → read_file A).
- **`routes.js`** — Добавлен анти-луп гард (`getRepeatedToolCalls`) в non-streaming path. Ранее проверка была только в SSE-пути, не-streaming запросы возвращали повторные tool_calls без фильтрации.

## Tool prompt fix + file cache for agent-loop stability (2026-06-14)

- **`toolUtils.js`** — Fixed `toolsToPrompt()`: rewrote from Russian to English, clarified JSON format with concrete example, removed negative phrasing. Language matches system message for better model compliance.
- **`fileCache.js` (new)** — In-memory cache for `read_file`/`list_directory` tool results. Populated from incoming tool results via `populateCacheFromMessages()`. Prevents redundant file reads in agent loops.
- **`routes.js`** — Added `populateCacheFromMessages()` call at start of request handler to build cache from tool results. Removed broken response-path interception (caused infinite loop). Anti-loop guard (`getRepeatedToolCalls`) now handles repeated calls via conversation history.
- **`docs/03_CODE_MAP.md`** — Added fileCache module to layout and key interfaces table.

## Documentation audit + dead code cleanup (2026-06-14)

- **`debug-trace.js` deleted** — broken import (`./logger/index.js` → doesn't exist), never imported anywhere. Dead code removed.
- **DeepSeek AvailableModels.txt** — synced with DEEPSEEK_MODELS config (2 → 6 models)
- **01_STATUS.md** — fixed DeepSeek LOC (600 → 1500), clarified page pool limits, removed outdated commentary
- **02_ARCHITECTURE.md** — complete rewrite: removed stream-of-consciousness prose, added proper mermaid diagrams, clear sections with short paragraphs, separated Qwen/DeepSeek flows
- **03_CODE_MAP.md** — fixed inaccuracies: modelMapping.js (no GPT/Claude aliases), fileRoutes.js (POST only), chatHistory.js paths, projectContext.js exports. Added missing files (adminRoutes.js, timeoutWrapper.js, powSolver.js). Added key interfaces table, config constants table, evaluate helpers table, dependencies table.
- **04_CHANGELOG.md** — this entry
- **05_OPEN_QUESTIONS.md** — updated: removed D11 (debug-trace fixed), added D12 (DeepSeek tests missing)

## Cross-account auth + JSON artifact stripping fixes (2026-06-13)

## Per-service log isolation (2026-06-13)

## Recent stabilization (Sessions 34–62, June 7–11)

## DeepSeek PoW & WASM (Sessions 63–)
