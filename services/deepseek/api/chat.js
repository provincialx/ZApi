// services/deepseek/api/chat.js — HTTP chat proxy with SSE streaming
import { logInfo, logError, logWarn } from "../../../shared/logger/index.js";
import { CHAT_API_URL, REQUEST_TIMEOUT_MINUTES } from "../config.js";
import { getStoredCookies } from "../browser/auth.js";

// Chat ID storage (simple JSON file)
const chatIds = new Map(); // conversation_id -> deepseek_chat_id

function generateId() {
  return "chat_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export function getChatId(conversationId) {
  if (!conversationId) return null;
  return chatIds.get(conversationId);
}

export function setChatId(conversationId, deepseekId) {
  chatIds.set(conversationId, deepseekId);
}

// Build the request body for DeepSeek API
function buildRequestBody(messages, model = "default") {
  const content = messages.length > 0 ? messages[messages.length - 1].content : "";

  // Handle thinking model toggle (DeepThink button in UI)
  const isThinkingModel = ["deepseek-r1", "deepthink"].includes(model.toLowerCase());

  return JSON.stringify({
    model: isThinkingModel ? "deep-reasoner" : "",
    thinking: { enabled: isThinkingModel },
    content: content,
    mode: "chat",
  });
}

// Send message to DeepSeek and return streaming callback data
export async function sendMessage(
  messages,
  model = "default",
  onChunk = null,
  captureToolCalls = false
) {
  const cookies = getStoredCookies();

  if (!cookies.length) {
    logWarn("Нет сохранённых куки для DeepSeek. Запустите авторизацию.");
    return {
      success: false,
      error: "Сессия DeepSeek не найдена. Выполните вход через браузер.",
    };
  }

  const content = messages.length > 0 ? messages[messages.length - 1].content : "";

  // Build cookie string from array of objects
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  logInfo(
    `🔁 DeepSeek запрос (${model}): ${typeof content === "string" ? content.slice(0, 60) : "array"}...`
  );

  return await executeApiRequest(content, model, cookieStr, onChunk);
}

async function executeApiRequest(content, model, cookieStr, onChunk) {
  const apiTimeoutMs = REQUEST_TIMEOUT_MINUTES * 60 * 1000;
  const isThinkingModel = ["deepseek-r1", "deepthink"].includes(model.toLowerCase());
  const startTime = Date.now();

  try {
    const requestBody = JSON.stringify({
      model: isThinkingModel ? "deep-reasoner" : "",
      thinking: { enabled: isThinkingModel },
      content,
      mode: "chat",
    });

    logDebug(`[${model}] Запрос к DeepSeek API (${requestBody.slice(0, 80)}...)`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), apiTimeoutMs);

    const response = await fetch(CHAT_API_URL, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/json;charset=UTF-8",
        Origin: "https://chat.deepseek.com",
        Referer: "https://chat.deepseek.com/",
        Cookie: cookieStr,
      },
      body: requestBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`DeepSeek API ошибка: ${response.status} - ${errorText.slice(0, 200)}`);
      return {
        success: false,
        status: response.status,
        errorBody: `HTTP ${response.status}: ${errorText.slice(0, 500)}`,
      };
    }

    // Check content type — DeepSeek uses text/event-stream for SSE
    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/event-stream")) {
      logWarn("DeepSeek вернул JSON вместо SSE.");
      // Handle as single JSON chunk
      return handleNonSseResponse(response, onChunk);
    }

    // Parse SSE stream
    return await parseSSEStream(response.body, model, onChunk);
  } catch (err) {
    logError("Ошибка выполнения запроса к DeepSeek", err);
    if (err.name === "AbortError") {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return { success: false, error: `Таймаут после ${elapsed}с` };
    }
    return { success: false, error: err.message };
  }

  function logDebug(msg) {
    if (process.env.LOG_LEVEL === "debug" || process.env.DEBUG) console.debug("[DS]", msg);
  }
}

async function parseSSEStream(stream, model, onChunk) {
  let fullContent = "";
  let thinkingContent = "";
  let inThinkingPhase = true; // DeepSeek outputs thinking first, then answer for R1 models
  let responseStarted = false;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;

        const dataStr = line.slice(5).trim();
        if (dataStr === "[DONE]" || !dataStr) continue;

        try {
          const json = JSON.parse(dataStr);

          // Track thinking elapsed → switch from thinking to answer phase
          if (json.p === "response/thinking_elapsed_secs") {
            inThinkingPhase = false;
            logInfo(`DeepSeek: дума${thinkingContent ? ` (${thinkingContent.length}симв)` : ""}`);
            continue;
          }

          // Extract content from SSE chunks
          const text = json.v || "";
          if (typeof text !== "string" || !text) continue;

          if (inThinkingPhase) {
            thinkingContent += text;
            // Send thinking tokens as regular content for now
            // TODO: Can add <thinking> tags in future
            if (onChunk && typeof onChunk === "function") {
              try {
                onChunk(text);
              } catch {}
            }
          } else {
            fullContent += text;
            if (onChunk && typeof onChunk === "function") {
              try {
                onChunk(text);
              } catch {}
            }
          }

          responseStarted = true;
        } catch (parseErr) {
          // Skip malformed SSE lines
        }
      }
    }
  } catch (streamErr) {
    if (streamErr.name !== "AbortError") {
      logWarn("Ошибка чтения потока DeepSeek:", streamErr.message);
    }
  }

  const totalLength = fullContent.length + thinkingContent.length;

  return {
    success: true,
    data: {
      content: fullContent,
      thinking: thinkingContent || null,
    },
    elapsedMs: Date.now() - startTime,
  };
}

async function handleNonSseResponse(response, onChunk) {
  const text = await response.text();

  if (onChunk && typeof onChunk === "function") {
    try {
      onChunk(text);
    } catch {}
  }

  return {
    success: true,
    data: { content: text },
  };
}

// Send message without streaming — returns full response
export async function sendMessageNonStreaming(messages, model = "default") {
  let result;

  const capturedChunks = [];

  return await sendMessage(
    messages,
    model,
    (chunk) => {
      capturedChunks.push(chunk);
    } // capture all chunks
  );

  // TODO: Return properly accumulated response
}
