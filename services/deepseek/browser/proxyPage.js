/**
 * Browser proxy page — executes DeepSeek API calls inside an authenticated browser context.
 */
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { logInfo, logWarn } from "../../../shared/logger/index.js";
import { CHAT_PAGE_URL, DEEPSEEK_MODELS } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = path.resolve(__dirname, "..", "..", "session");
const DEEPSEEK_ACCOUNTS_FILE = path.join(ACCOUNTS_PATH, "deepseek_accounts.json");

let browser = null;
let page = null;

function loadSavedCookies() {
  try {
    const data = JSON.parse(fs.readFileSync(DEEPSEEK_ACCOUNTS_FILE, "utf8"));
    if (Array.isArray(data) && data.length > 0) {
      // First account is the latest saved session
      return data[0].cookies || [];
    }
  } catch {}
  return null;
}

export async function initBrowserPage() {
  if (page) return true;

  try {
    puppeteer.use(StealthPlugin());
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Restore saved cookies BEFORE navigation (authentication is in cookies)
    const savedCookies = loadSavedCookies();
    if (savedCookies && savedCookies.length > 0) {
      await page.setCookie(...savedCookies);
      logInfo(`[BrowserProxy] Загружено ${savedCookies.length} cookie из сессии`);
    }

    await page.goto(CHAT_PAGE_URL, { waitUntil: "networkidle2", timeout: 30_000 });

    const loggedIn = await page.evaluate(() => {
      return !!document.cookie.match(/aws-waf-token/);
    });

    if (!loggedIn) {
      logWarn("[BrowserProxy] Страница не авторизована.");
    } else {
      logInfo("[BrowserProxy] Браузерная страница готова (авторизован)");
    }
  } catch (err) {
    logWarn("[BrowserProxy] Ошибка инициализации:", err.message);
  }

  return !!page;
}

// ─── Chat session management ────────────────────────────────
// Stores conversation_hint → { sessionId, parentMessageId }
const chatSessions = new Map();

async function ensureSession(conversationHint) {
  // Return existing session or create one
  const hint = conversationHint || "_default";
  if (chatSessions.has(hint)) return chatSessions.get(hint);

  try {
    const result = await page.evaluate(async () => {
      const resp = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json;charset=UTF-8",
          Origin: "https://chat.deepseek.com",
          Referer: "https://chat.deepseek.com/",
          "Accept-Language": "en-US,en;q=0.9",
          "x-client-platform": "web",
        },
        credentials: "include",
        body: JSON.stringify({}),
      });

      const text = await resp.text();
      if (!resp.ok) return { error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };

      try {
        const json = JSON.parse(text);
        // Detect INVALID_TOKEN — session cookies expired, need re-auth
        if (
          json?.code === 40003 ||
          (json?.msg && String(json.msg).toLowerCase().includes("token"))
        ) {
          return { error: "INVALID_TOKEN", raw: text.slice(0, 500) };
        }
      } catch {}

      const sessionId = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id || null;
      return { sessionId, raw: text.slice(0, 300) };
    });

    if (result.error && result.error.includes("INVALID_TOKEN")) {
      logWarn(`[BrowserProxy] 🔴 Cookie истекли! Запустите авторизацию заново (меню → пункт 1)`);
      // Clear cached session so we retry next time
      chatSessions.clear();
    } else if (result.error) {
      logWarn(`[BrowserProxy] createSession failed: ${result.error}`);
    }

    if (result.sessionId) {
      logInfo(`[BrowserProxy] Создана сессия: ${result.sessionId.slice(0, 12)}...`);
      const session = { sessionId: result.sessionId, parentMessageId: null };
      chatSessions.set(hint, session);
      return session;
    }
  } catch (err) {
    logWarn(`[BrowserProxy] createSession exception: ${err.message}`);
  }

  // Fallback: use random UUID — messages will work but chats won't be visible on web
  const fallback = { sessionId: crypto.randomUUID(), parentMessageId: null };
  chatSessions.set(hint, fallback);
  return fallback;
}

export async function sendViaBrowser(messages, model, conversationHint) {
  if (!page) {
    logWarn("[BrowserProxy] Страница не инициализирована.");
    return { success: false, error: "Нет активной страницы браузера" };
  }

  // Ensure we have a valid chat session for this conversation
  const session = await ensureSession(conversationHint);

  try {
    const lastMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";

    // Resolve model config from DEEPSEEK_MODELS (handles aliases properly)
    const cfg = DEEPSEEK_MODELS[model] ?? DEEPSEEK_MODELS["deepseek-v3"];

    // Build message history context (Human:/Assistant: format for DeepSeek v0 API)
    let promptText = "";
    const nonSystem = messages.filter((m) => m.role !== "system");
    for (const msg of nonSystem) {
      const label = msg.role === "user" ? "\nHuman: " : "\nAssistant: ";
      if (Array.isArray(msg.content)) {
        promptText += label + msg.content.map((p) => p.text || JSON.stringify(p)).join("");
      } else {
        promptText += label + (msg.content || "");
      }
    }

    logInfo(
      `[BrowserProxy] Запрос: model_type=${cfg.model_type}, thinking=${cfg.thinking_enabled}`
    );

    logInfo(
      `[BrowserProxy] Сессия: ${session.sessionId}${session.parentMessageId ? `, parentMsg: ${session.parentMessageId}` : ``}`
    );

    return await page.evaluate(
      async ({ prompt, cfg, session }) => {
        const apiUrl = "https://chat.deepseek.com/api/v0/chat/completion";

        // Extract auth tokens from cookies for Authorization header
        const getCookie = (name) => {
          const match = document.cookie.match(
            new RegExp("(?:^|;)\\s*" + name + "\\s*=\\s*([^;]+)")
          );
          return match ? match[1].trim() : null;
        };

        const bearerToken = getCookie("aws-waf-token") || null;

        // Use session ID passed from Node.js layer (created via ensureSession)
        const chatSessionId = session?.sessionId || crypto.randomUUID();
        const parentMessageId = session?.parentMessageId || null;

        const body = {
          model_type: cfg.model_type || "default",
          prompt,
          thinking_enabled: cfg.thinking_enabled ?? false,
          search_enabled: false,
          ref_file_ids: [],
          action: null,
          preempt: false,
          chat_session_id: chatSessionId,
        };

        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            Accept: "*/*",
            "Content-Type": "application/json;charset=UTF-8",
            Origin: "https://chat.deepseek.com",
            Referer: "https://chat.deepseek.com/",
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
            "x-client-platform": "web",
            "x-client-version": "20250611.1",
          },
          credentials: "include", // send cookies automatically
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errText = await response.text();
          return { success: false, error: `HTTP ${response.status}: ${errText.slice(0, 200)}` };
        }

        // Check content-type — DeepSeek may return JSON instead of SSE
        const contentType = response.headers.get("content-type") || "";

        if (!contentType.includes("text/event-stream")) {
          // Handle as single JSON response
          const text = await response.text();
          let fullContent = text;
          try {
            const json = JSON.parse(text);
            if (json?.data?.delta) {
              fullContent = json.data.delta;
            } else if (json?.message) {
              fullContent = json.message;
            } else if (Array.isArray(json)) {
              fullContent = json
                .map((item) => {
                  try {
                    const parsed =
                      typeof item === "string" ? JSON.parse(item.replace(/^data: /, "")) : item;
                    return parsed?.v || parsed?.delta || parsed?.content || "";
                  } catch {
                    return "";
                  }
                })
                .join("");
            }
          } catch {}

          // Debug info for diagnostics
          let debugKeys = null;
          try {
            debugKeys = Object.keys(JSON.parse(text)).slice(0, 10);
          } catch {}

          return {
            success: true,
            data: { content: fullContent },
            _debug: {
              contentType: "json",
              keys: debugKeys,
              rawLength: text.length,
              sample: text.slice(0, 200),
            },
          };
        }

        // Parse SSE stream (same format as chat.js)
        let fullContent = "";
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let firstChunkSample = null;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;

              const dataStr = line.slice(5).trim();
              if (!dataStr || dataStr === "[DONE]") continue;

              try {
                const json = JSON.parse(dataStr);

                // Skip thinking elapsed marker
                if (json.p === "response/thinking_elapsed_secs") continue;

                // Debug: capture first chunk structure
                if (!firstChunkSample) {
                  firstChunkSample = {
                    keys: Object.keys(json),
                    sample: JSON.stringify(json).slice(0, 300),
                  };
                }

                // Extract text from delta chunks (v field)
                if (json.v && typeof json.v === "string") {
                  fullContent += json.v;
                }
              } catch {}
            }
          }
        } catch (e) {}

        return {
          success: true,
          data: { content: fullContent },
          _debug: {
            contentType: "sse",
            firstChunk: firstChunkSample,
            contentLength: fullContent.length,
          },
        };
      },
      {
        prompt: promptText || lastMsg,
        cfg: {
          model_type: cfg.model_type,
          thinking_enabled: cfg.thinking_enabled,
          search_enabled: cfg.search_enabled ?? false,
        },
        session: { sessionId: session.sessionId, parentMessageId: session.parentMessageId },
      }
    );
  } catch (err) {
    logWarn("[BrowserProxy] Ошибка отправки через браузер:", err.message);
    return { success: false, error: err.message };
  }
}

export async function shutdownBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
}
