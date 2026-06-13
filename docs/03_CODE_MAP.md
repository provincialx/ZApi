# 03 — Code Map (Post-S61 Multi-Provider)

## Module layout

```
index.js                                    # Dispatcher: choose provider → fork child process
│   └── SERVICES array → fork(entry), signal forwarding: SIGINT/SIGTERM/SIGHUP → child.kill(sig)

shared/                                     # Common utilities (relative imports from any depth)
├── config.js                               # Base: PORT, HOST, LOG_LEVEL, LOG_MAX_SIZE, LOGS_DIR
├── logger/index.js                         # Winston + Morgan: logInfo/logWarn/logError/logDebug/logRaw/logHttp
└── utils/prompt.js                         # CLI readline prompt helper

services/                                   # Provider-isolated modules — each runs as separate process

├── qwen/                                   # Qwen Chat proxy (Aliyun WAF bypass, multi-account)
│   ├── index.js                            # Entry: Express app + account menu. startQwenProxy/showAccountMenu
│   ├── config.js                           # Qwen-specific: CHAT_API_URL, PAGE_TIMEOUT, PAGE_POOL_SIZE,
│   │                                      #   MAX_ACTIVE_PAGES(5), BROWSER_RESTART_RSS_MB(512),
│   │                                      #   MEMORY_CHECK_INTERVAL(20), REQUEST_TIMEOUT_MINUTES(5)
│   ├── data/
│   │   ├── Authorization.txt              # API keys (Bearer token whitelist)
│   │   └── AvailableModels.txt            # Model names list (28 models)
│   │
│   ├── api/                                # OpenAI-compatible endpoints + Qwen Web interaction
│   │   ├── routes.js                       # Main handler (~1030 LOC). Chat ID resolution, streaming/
│   │   │                                  #   non-streaming paths, agent-loop logic, tool call folding.
│   │   │                                  #   Imports from shared/ via ../../../shared/logger/...
│   │   ├── qwenApi.js                      # Qwen API interaction (~1284 LOC). Two-path strategy,
│   │   │                                  #   retry policy, CAPTCHA resolution, sendMessage/createChatV2/
│   │   │                                  #   testToken. Path 2: browser evaluate with authToken param
│   │   ├── chatSession.js                  # Chat ID map/model defaults (~630 LOC). resolveQwenChatId
│   │   │                                  #   (3-level fallback), session persistence, force-fold triggers,
│   │   │                                  #   chatTokenOwner binding. GC: stale sessions >24h, caps on maps
│   │   ├── openaiUtils.js                  # Message parsing (~400 LOC). parseOpenAIMessages,
│   │   │                                  #   hasOpenAIToolState, buildStatelessTranscript, folding helpers.
│   │   │                                  #   Pure functions — no side effects.
│   │   ├── responseBuilders.js             # SSE chunk construction (~260 LOC). writeToolCallsSse (incremental
│   │   │                                  #   deltas, 500-char arg chunks), handleStreamingResponse.
│   │   ├── chat.js                         # Token state + model/key loaders (~180 LOC). Re-exports
│   │   │                                  #   evaluateWithTimeout/evaluateInBrowser from pagePool.js.
│   │   │                                  #   extractAuthToken, getAvailableModelsFromFile
│   │   ├── toolUtils.js                    # Tool prompt injection & JSON extraction (~500 LOC).
│   │   │                                  #   applyToolPrompt, parseToolCallParts (brace repair),
│   │   │                                  #   normalizeToolCalls, toolsToPrompt/toolsToLightPrompt.
│   │   │                                  #   Anti-loop: getRepeatedToolCalls.
│   │   ├── modelMapping.js                 # Qwen model name aliases (only Qwen variants, no GPT/Claude).
│   │   │                                  #   28 canonical models + alias groups. getMappedModel fallback
│   │   │                                  #   to DEFAULT_MODEL on no match.
│   │   ├── tokenManager.js                 # Token rotation, account status (OK/RATELIMIT/INVALID).
│   │   │                                  #   loadTokens/saveTokens → session/tokens.json.
│   │   ├── adminRoutes.js                  # Admin endpoints: /health, /models (OpenAI format), /status,
│   │   │                                  #   /chats (POST create). Uses FORGETMEAI_WATERMARK branding.
│   │   ├── timeoutWrapper.js               # withRequestTimeout(promise, label) — Promise.race vs setTimeout.
│   │   │                                  #   Uses REQUEST_TIMEOUT_MINUTES from config.
│   │   ├── projectContext.js               # Anti-hallucination: filesystem scan → compact tree inject.
│   │   │                                  #   getProjectStructureAsync() async scan; buildProjectContext()
│   │   │                                  #   sync cache. Excludes: node_modules, .git, session, logs, uploads.
│   │   ├── chatHistory.js                  # Local chat history persistence (JSON files per chatId).
│   │   │                                  #   Path: SESSION_DIR/history/{chatId}.json. loadHistory, saveHistory,
│   │   │                                  #   createChat, deleteChat. MAX_HISTORY_LENGTH=100.
│   │   ├── fileRoutes.js                   # File upload + chat history API routes. POST /files/getstsToken,
│   │   │                                  #   POST /files/upload (multer), GET/POST /chats/:chatId/history.
│   │   └── fileUpload.js                   # Alibaba Cloud OSS upload via STS credentials. uploadFileToQwen:
│   │                                      #   getStsToken (browser evaluate fetch) → uploadFile (OSS SDK in
│   │                                      #   browser). MAX_FILE_SIZE=10MB.
│   │
│   ├── browser/                            # Puppeteer + Chromium management
│   │   ├── browser.js                      # Puppeteer launch (~370 LOC). initBrowser(visible?),
│   │   │                                  #   shutdownBrowser, restartBrowserInHeadlessMode.
│   │   │                                  #   StealthPlugin, --disable-web-security, protocolTimeout sync.
│   │   ├── pagePool.js                     # Page pool (~374 LOC). getPage/releasePage with health check.
│   │   │                                  #   Max pool=3, max active=5. GC: idle TTL 5min, interval 60s.
│   │   │                                  #   Memory Guard RSS restart. evaluateWithTimeout (5s) /
│   │   │                                  #   evaluateInBrowser (long-lived, synced to REQUEST_TIMEOUT).
│   │   ├── auth.js                         # Auth verification + CAPTCHA resolution. checkAuthentication,
│   │   │                                  #   startManualAuthentication, checkVerification. Uses console.log
│   │   │                                  #   for interactive prompts.
│   │   └── session.js                      # Cookie/token persistence. saveSession/loadSession per-account:
│   │                                      #   session/accounts/{id}/cookies.json. saveAuthToken/loadAuthToken
│   │                                      #   for global token.txt.
│   │
│   └── utils/
│       ├── branding.js                     # CONTACT_INFO, FORGETMEAI_WATERMARK
│       └── accountSetup.js                 # Account CLI: addAccountInteractive, reloginAccountInteractive,
│                                           #   removeAccountInteractive. Uses shared/utils/prompt.js.
│
└── deepseek/                               # DeepSeek Chat proxy (Cookie + PoW → HTTP fetch)
    ├── index.js                            # Entry: Express app + session menu. OpenAI-compatible routes
    │                                       #   at /api/v1/*. 6 model aliases. Port chain: DEEPSEEK_PORT
    │                                       #   ?? PORT ?? DEFAULT_PORT.
    ├── config.js                           # DeepSeek-specific: CHAT_API_URL, PAGE_TIMEOUT(60s),
    │                                       #   DEEPSEEK_MODELS (7 aliases with model_type/thinking/search),
    │                                       #   REQUEST_TIMEOUT_MINUTES via DEEPSEEK_REQUEST_TIMEOUT env.
    ├── data/
    │   └── AvailableModels.txt             # Model aliases (6 models, synced with config)
    │
    ├── api/
    │   └── chat.js                         # Message handling, SSE parser (~350 LOC). sendMessage with
    │                                       #   PoW solving via powSolver.js, executeApiRequest with direct
    │                                       #   fetch(), parseSSEStream/parseNonSSEResponse. Session Map.
    │
    ├── browser/
    │   ├── auth.js                         # Cookie/session extraction via Puppeteer (~800 LOC). 3-source
    │   │                                   #   PoW data collection (JS interceptors, CDP network,
    │   │                                   #   page.evaluate). Stores to deepseek_accounts.json.
    │   └── proxyPage.js                    # Browser-init + message sending (~700 LOC). initBrowserPage
    │                                       #   with CDP session, WASM preload (3-phase strategy),
    │                                       #   sendViaBrowser with PoW solve in browser context.
    │
    └── utils/
        └── powSolver.js                    # Pure JS PoW solver (SHA3-256 hashcash). Replaces WASM.
                                            #   solvePoW(challenge) → {nonce, powData: base64}. Uses js-sha3.
```

## Key interfaces

| Function / Export | Module | Purpose |
|---|---|---|
| `sendMessage()` | `qwenApi.js` | Core Qwen API call — two-path strategy, retry, CAPTCHA resolution |
| `createChatV2()` | `qwenApi.js` | Create Qwen chat via browser evaluate / Node.js fetch |
| `resolveQwenChatId()` | `chatSession.js` | 3-level chat ID resolution (map → defaults → create new) |
| `invalidateQwenChatId()` | `chatSession.js` | Clean ALL maps on "chat_not_exist" error |
| `parseToolCallParts()` | `toolUtils.js` | Extract tool calls from Qwen JSON response |
| `applyToolPrompt()` | `toolUtils.js` | Inject tool definitions into system message |
| `normalizeToolCalls()` | `toolUtils.js` | Convert raw calls → OpenAI format |
| `buildStatelessTranscript()` | `openaiUtils.js` | Fold history → single user message |
| `hasOpenAIToolState()` | `openaiUtils.js` | Detect tool calls in message history |
| `handleApiError()` | `qwenApi.js` | Classify + route errors (401/429/503/generic) |
| `resolveAuthToken()` | `qwenApi.js` | Token resolution with preferredOwner binding |
| `getAvailableToken()` | `tokenManager.js` | Round-robin token selection |
| `withRequestTimeout()` | `timeoutWrapper.js` | Promise timeout wrapper |
| `evaluateWithTimeout()` | `pagePool.js` | Fast page health check (5s) |
| `evaluateInBrowser()` | `pagePool.js` | Long-lived browser evaluate (synced to REQUEST_TIMEOUT) |
| `solvePoW()` | `powSolver.js` | DeepSeek PoW challenge solver (SHA3-256) |
| `sendViaBrowser()` | `proxyPage.js` | DeepSeek message send via browser context |
| `initBrowserPage()` | `proxyPage.js` | DeepSeek proxy init with CDP + WASM preload |

## Config constants

| Constant | Default | Module | Description |
|---|---|---|---|
| `PORT` | 3264 | `shared/config.js` | Server port |
| `HOST` | 0.0.0.0 | `shared/config.js` | Server host |
| `LOG_LEVEL` | info | `shared/config.js` | Logging level |
| `PAGE_POOL_SIZE` | 3 | `qwen/config.js` | Max idle pages in pool |
| `MAX_ACTIVE_PAGES` | 5 | `qwen/config.js` | Max concurrent active pages |
| `PAGE_IDLE_TTL_MS` | 300000 | `qwen/config.js` | Idle page GC TTL (5 min) |
| `PAGE_GC_INTERVAL_MS` | 60000 | `qwen/config.js` | GC check interval (1 min) |
| `BROWSER_RESTART_RSS_MB` | 512 | `qwen/config.js` | Memory Guard RSS threshold |
| `REQUEST_TIMEOUT_MINUTES` | 5 | `qwen/config.js` | Qwen request timeout |
| `STREAMING_CHUNK_DELAY` | 20 | `qwen/config.js` | SSE chunk delay (ms) |
| `DEFAULT_MODEL` | qwen-max-latest | `qwen/config.js` | Fallback model |
| `MAX_HISTORY_LENGTH` | 100 | `qwen/config.js` | Local chat history limit |

## Evaluate helpers

| Helper | Timeout | Purpose |
|---|---|---|
| `evaluateWithTimeout(page, fn)` | 5s (EVALUATE_HEALTH_TIMEOUT) | Fast health check — page alive? |
| `evaluateInBrowser(page, fn, args)` | ~5.5 min (synced to REQUEST_TIMEOUT) | Long-running API calls in browser |

## Dependencies (package.json)

| Dependency | Version | Purpose |
|---|---|---|
| express | ^4.18.2 | HTTP server |
| puppeteer | ^24.31.0 | Browser automation |
| puppeteer-extra + stealth | ^3.3.6 / ^2.11.2 | Anti-detection |
| winston | ^3.17.0 | Logging |
| morgan | ^1.10.0 | HTTP request logging |
| js-sha3 | ^0.9.3 | DeepSeek PoW solver |
| openai | ^4.104.0 | OpenAI API client (tool call types) |
| ali-oss | ^6.18.0 | Alibaba Cloud OSS (file upload) |
| multer | ^2.0.0 | File upload parsing |
| dotenv | ^17.4.2 | Env config |
