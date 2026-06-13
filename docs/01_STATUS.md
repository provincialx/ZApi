# ZApi — Status (2026-06-14)

## Health: GREEN — Anti-loop detection fixed + cross-turn repeat guard

### Architecture S61+: Multi-Provider Separation

Process-level isolation via `index.js` dispatcher → `child_process.fork()`. Each provider runs as independent process with dedicated browser/memory/logs.

| Area | Status | Notes |
|------|--------|-------|
| Multi-provider architecture | Working | `index.js` → forks Qwen/DeepSeek as isolated child processes with signal forwarding |
| Tool calling (SSE + streaming) | Working | Qwen: prompt injection + JSON parse roundtrip via `toolUtils.js`. DeepSeek: native OpenAI tool_calls pass-through. |
| Agent-loop stability | Working | Qwen: deferred auto-reset, cooldown, same-chat retry on "in progress". Anti-loop guard: cross-turn repeat detection (tool_call_id matching) + anti-thinking-loop (>3 sequentialthinking). Covers both stream and non-stream paths. DeepSeek: N/A (single-message model). |
| Chat management | Working | Qwen: layered fallback (chatIdMap → modelDefaultChats → create new). Cross-account auth fixed. DeepSeek: simple in-memory Map. |
| Page pool memory (Qwen) | Mitigated | Pool size=3 idle, max 5 concurrent. Idle TTL 5min, GC every 60s, Memory Guard RSS restart at 512MB. |
| Timeout enforcement | Active | `REQUEST_TIMEOUT_MINUTES` (5m) wrapper + protocolTimeout synced. Path 2 fetch timeout 20s. |
| CAPTCHA resolver (Qwen) | Working | Centralized `resolveCaptchaAndRetry()`, JWT inject, `SIMULATE_CAPTCHA` test mode. |
| Aliyun WAF bypass (Qwen) | Working | Path 2: `fetch()` in main world via WAF SDK, no `Authorization: Bearer`, `networkidle0` + 2s pause. |
| Unit tests | Passing | 46/46 (`npm test`). Anti-loop tests cover all-turn detection with tool_call_id matching. |
| ESLint | Clean | 0 errors, ~37 warnings (unused imports — tech-debt) |
| Logging isolation | Working | Per-service log dirs: `logs/qwen/`, `logs/deepseek/` via `LOGS_DIR` env |
| Prettier | Formatted | All files clean |

## Provider Comparison

| Feature | Qwen (`services/qwen/`) | DeepSeek (`services/deepseek/`) |
|---------|-------------------------|----------------------------------|
| **API URL** | `chat.qwen.ai/api/v2/chat/completions` | `chat.deepseek.com/api/v0/chat/completion` |
| **Auth** | Token-based (JWT in localStorage). Multi-account via cookie-per-account. | Cookie + deep recursive storage extraction (token, wasmUrl, hif_dliq/hif_leim). |
| **WAF/Protection** | Aliyun WAF + CSP block. Two-path strategy (browser evaluate). | CloudFront + Proof-of-Work (WASM solver via `js-sha3`). Header: `X-DS-PoW-Response`. |
| **Tool Calls** | Custom prompt injection + JSON parse roundtrip (`toolUtils.js`). | Native OpenAI `tools[]` format — proxy pass-through. |
| **Models** | qwen3.7-max, qwen3.7-plus, qwen3.6-plus, qwen3.5-plus/flash, qwen3-max, qwen3-coder-plus, +20 more | 6 aliases: v3/chat/default (V4 Flash), r1/reasoner (Thinking), expert/v4-pro (Expert + reasoning). |
| **Memory footprint** | ~500MB+ (Chromium pool + page.evaluate locks) | ~50MB (Express only, no persistent browser) |
| **Code size** | ~26 files, ~4500 LOC | ~7 files, ~1500 LOC |

## Quick Start

```bash
node index.js          # Dispatcher: choose provider → forks child process
npm test               # Unit tests (no browser required)
npm run lint           # ESLint check
npm run format         # Prettier write
node scripts/auth.js   # Qwen account management CLI (--list, --add, --relogin, --remove)
```

## Critical Architecture Changes (S61+)

### Process-level isolation via child_process.fork()

`index.js` — pure dispatcher. Selected service forked as separate process with `stdio: "inherit"`. Parent forwards SIGINT/SIGTERM/SIGHUP. Each provider runs on its own port (Qwen: 3264, DeepSeek: configurable via `DEEPSEEK_PORT`).

### Shared directory pattern

Common utilities in `shared/`: config, logger, CLI prompt. Imported via relative paths from any depth (`../../../shared/logger/...`). Future providers only need `services/<name>/index.js` + API layer.

### Dead code removed

- `services/qwen/api/debug-trace.js` — deleted (broken import, unused)
