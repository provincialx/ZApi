# 04 — Changelog

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
