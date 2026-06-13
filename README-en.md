# ZApi — Multi-Provider OpenAI-Compatible API Proxy

![Contact](https://img.shields.io/badge/Contact-mandrykinsergey@-blue)
![API](https://img.shields.io/badge/API-OpenAI--compatible-green)
![Providers](https://img.shields.io/badge/Providers-Qwen+|+DeepSeek-purple)

> **Turns [Zed.dev](https://zed.dev/) into a full AI agent** using your Qwen Chat and/or DeepSeek web accounts.
> Contact: `mandrykinsergey@gmail.com` | [twitch.tv/dnovitv](https://www.twitch.tv/dnovitv)

## What is this?

Zed.dev is one of the fastest code editors available. It has a built-in AI agent that can read files, run terminal commands, and write code based on your prompts. But **Zed doesn't include a model** — it just talks to an OpenAI-compatible API.

ZApi bridges Zed with free web-based LLM services (Qwen Chat, DeepSeek). It handles authentication, WAF bypass, and Proof-of-Work solving, then serves model responses at `http://localhost:3264/api` in standard OpenAI format.

**Result:** Zed Agent gets access to powerful models — it can read your codebase, edit files, and run terminal commands as a fully autonomous agent. All for free using basic web accounts.

**This is not a locally downloaded model** and **not an official API**. It's a browser-based proxy with multi-provider support.

```text
Zed Agent → ZApi (localhost:3264) ─┬─ Qwen    (Puppeteer + WAF bypass)
                                   └─ DeepSeek (PoW solver + HTTP fetch)
```

## Agent Capabilities

| Provider | Agent Status | Details |
|----------|-------------|---------|
| **Qwen** | ✅ Full agent | Tool calls, file read/write, agent-loop, SSE streaming. **Actively developed.** |
| **DeepSeek** | ⚠️ Read-only | Can read files via tools, but **cannot edit/write them** yet. API supports it, integration pending. |

## Getting Started

Requires [Node.js](https://nodejs.org/) version 18+.

### 1. Install and first run
```bash
git clone https://github.com/provincialx/ZApi
cd ZApi
npm install
```

### 2. Start the dispatcher
```bash
node index.js
```
You'll be prompted to choose a provider:
- **1 — Qwen** (full agent, WAF bypass, multi-account)
- **2 — DeepSeek** (read-only agent, PoW solver, lightweight)

### Qwen setup (recommended for full agent)

Add a Qwen account (opens a Chromium browser window — log in at `chat.qwen.ai`, then press Enter):
```bash
node scripts/auth.js
# Menu → option 1 — Add new account
```

Then start with `SKIP_ACCOUNT_MENU=true` for headless mode:
```bash
SKIP_ACCOUNT_MENU=true node index.js
# Select 1 — Qwen
```

### DeepSeek setup

Select option 2 — DeepSeek from the dispatcher menu, then:
1. Choose **1 — Login to DeepSeek** (opens a browser — log in via GitHub/Google)
2. Send any message to trigger Proof-of-Work module load
3. Press Enter. Session saved automatically.
4. Choose **3 — Start proxy**.

## Connecting to Zed.dev

1. Install [Zed](https://zed.dev/).
2. Open settings: `Cmd+Shift+,` → **AI** tab.
3. Set **Base URL** to: `http://localhost:3264/api`
4. Set **API Key** to anything (e.g., `dummy-key`) — the server doesn't validate it
5. Set **Model** to your preferred option (see provider-specific models below)
6. Save. Zed Agent is now ready to use.

### Qwen recommended models
- `qwen3-coder-plus` — best for coding agent tasks
- `qwen3.7-max` — most powerful, may occasionally ignore tool instructions on "dirty" accounts

### DeepSeek models
- `deepseek-v3` — fast (V4 Flash)
- `deepseek-r1` — thinking/reasoning mode
- `deepseek-expert` — expert mode (V4 Pro)
- `deepseek-v4-pro` — expert + reasoning

> **⚠️ Qwen important:** In your chat.qwen.ai profile → Personalization — disable all toggles, set style to "Concise", and clear any saved memory.

## Tool Calling

Zed Agent can invoke external tools using the standard OpenAI tool calling protocol: reading files, writing code, running terminal commands. The model decides which tools to call, invokes them through Zed, receives results, and continues working — all automatically (agent loop).

### Qwen (custom prompt injection)
Qwen Chat's web API **does not accept tools** in standard OpenAI format. ZApi works around this:
1. Tool schemas are injected into the user message as text instructions (prompt injection).
2. Qwen generates tool calls as a JSON block within its normal text response.
3. The proxy parses this block, strips extraneous text, and returns clean `tool_calls` to Zed Agent.

Works reliably even with large tool lists thanks to schema compression (`MAX_SCHEMA_LEN=6000`) and built-in anti-loop guards.

### DeepSeek (native OpenAI format)
DeepSeek supports native `tools[]` parameter — the proxy simply passes them through. No JSON parsing or injection needed.

## Multi-Account & Rate Limits

Free Qwen accounts have per-minute/per-hour request limits. ZApi supports multiple accounts:
- `node scripts/auth.js` → menu options to add/list/remove accounts
- When the current account hits its limit → server auto-switches to next available (round-robin)
- Account statuses tracked: `OK` / `WAIT` / `INVALID`

DeepSeek uses a single session per instance.

## Commands Reference

| Command | Description |
|---------|-------------|
| `node index.js` | Start dispatcher — choose provider |
| `node scripts/auth.js` | Qwen account management (add/list/remove/relogin) |
| `npm test` | Run 46 unit tests (Node.js test runner, no browser) |
| `npm run lint` / `format` | Code style checks (ESLint + Prettier) |

## Limitations & Caveats

- **Unofficial proxy.** Providers may change site structure or API URLs at any time.
- **Qwen "dirty memory".** Old conversations and personalization data may cause the model to ignore tool instructions. Clear browser cookies or switch to `qwen3-coder-plus`.
- **Race condition ("in progress").** Qwen processes SSE sessions for a few seconds after delivering the full response. ZApi auto-pauses (~1-2s) and retries on the same chat.
- **Browser memory (Qwen).** During long sessions (>100 calls) Chromium consumes more RAM. Built-in GC closes idle pages after 5 minutes, hard limit of 5 concurrent pages, auto-restart at 512 MB RSS.
- **DeepSeek read-only.** Can read files but not edit them yet.

## Developer Documentation

- [docs/01_STATUS.md](docs/01_STATUS.md) — current system stability status
- [docs/02_ARCHITECTURE.md](docs/02_ARCHITECTURE.md) — data flow diagrams (normal request vs agent-loop)
- [docs/03_CODE_MAP.md](docs/03_CODE_MAP.md) — module map, key interfaces, and config constants
- [docs/04_CHANGELOG.md](docs/04_CHANGELOG.md) — full development history (sessions 1–67)
- [docs/05_OPEN_QUESTIONS.md](docs/05_OPEN_QUESTIONS.md) — open issues, known quirks, and constraints

## Support the Author

If you found this project useful or it saved you time — reach out:
`mandrykinsergey@gmail.com` | [twitch.tv/dnovitv](https://www.twitch.tv/dnovitv)
