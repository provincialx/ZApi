// services/deepseek/index.js — Entry point for DeepSeek proxy service
import express from "express";
import bodyParser from "body-parser";

import { sendMessage } from "./api/chat.js";
import { addAccountInteractive, clearSession, hasValidSession } from "./browser/auth.js";
import { logHttpRequest, logInfo, logError, logWarn } from "../../shared/logger/index.js";
import { prompt } from "../../shared/utils/prompt.js";
import { PORT as DEFAULT_PORT, HOST as DEFAULT_HOST } from "../../shared/config.js";

const app = express();

export const port = Number.parseInt(process.env.DEEPSEEK_PORT ?? process.env.PORT ?? DEFAULT_PORT, 10);
export const host = process.env.HOST || DEFAULT_HOST;

// Middleware
app.use(logHttpRequest);
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// CORS headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── OpenAI-compatible API routes ──────────────────────────────

app.get("/api/v1/models", (_req, res) => {
  const models = [
    { id: "deepseek-v3", object: "model" },
    { id: "deepseek-r1", object: "model" }, // Thinking/reasoning mode
  ];

  return res.json({ object: "list", data: models });
});

// Main chat endpoint — OpenAI compatible
app.post("/api/v1/chat/completions", async (req, res) => {
  const messages = req.body?.messages || [];
  const model = req.body?.model || "deepseek-v3";
  const isStreaming = req.body?.stream === true;

  if (!hasValidSession()) {
    return res.status(401).json({ error: "Сессия не найдена. Запустите авторизацию." });
  }

  // Extract content from messages (DeepSeek web API takes last user message only)
  const userMsg = [...messages].reverse().find((m) => m.role === "user");
  if (!userMsg || !userMsg.content) {
    return res.status(400).json({ error: "Нет пользовательского сообщения." });
  }

  // Prepare full message history context (append previous messages to user content)
  let contentText = "";
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  for (const msg of nonSystemMessages) {
    const roleLabel = msg.role === "user" ? "\nHuman: " : "\nAssistant: ";

    // Handle content array (multimodal images etc.)
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          contentText += roleLabel + part.text;
        }
      }
    } else {
      contentText += roleLabel + (msg.content || "");
    }
  }

  const startTime = Date.now();

  try {
    if (!isStreaming) {
      // Non-streaming: wait for full response, then return standard OpenAI format
      let capturedContent = "";

      await sendMessage(
        [{ role: "user", content: userMsg.content }],
        model,
        (chunk) => { capturedContent += chunk; }
      );

      const completionTokens = estimateTokens(capturedContent);

      return res.json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: capturedContent },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: estimateTokens(contentText),
          completion_tokens: completionTokens,
          total_tokens: estimateTokens(contentText) + completionTokens,
        },
      });
    }

    // ─── Streaming response (SSE) ──────────────────────

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Send initial role chunk
    const roleChunk = buildSSE({
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant" } }],
    });
    res.write(roleChunk);

    let fullContent = "";

    await sendMessage(
      [{ role: "user", content: userMsg.content }],
      model,
      (chunk) => {
        fullContent += chunk;
        const dataChunk = buildSSE({
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: chunk } }],
        });

        if (!res.writableEnded) res.write(dataChunk);
      }
    );

    // Final [DONE] chunk
    const doneChunk = buildSSE({
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });

    if (!res.writableEnded) {
      res.write(doneChunk);
      res.end();
      logInfo(`DeepSeek ${model}: ответ за ${(Date.now() - startTime / 1000).toFixed(1)}с (${fullContent.length} симв)`);
    }

  } catch (err) {
    if (!res.writableEnded) {
      res.json({ error: "Ошибка генерации", details: err.message });
    }
    logError("Ошибка обработки запроса DeepSeek", err);
  }
});

// ─── Helper functions ──────────────────────────────────────

function buildSSE(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function estimateTokens(text) {
  // Rough estimation — ~1 token per word + extra for special chars
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherWords = text.replace(/[\u4e00-\u9fff]/g, "").split(/\s+/).filter(Boolean).length;
  return chineseChars + Math.ceil(otherWords * 1.2);
}

// Error handling middleware
app.use((err, req, res) => {
  logError("Внутренняя ошибка сервера", err);
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

export function showAccountMenu() {
  return new Promise(async (resolve) => {
    while (true) {
      console.log("\n=== Меню DeepSeek ===");

      if (!hasValidSession()) {
        console.log("Статус: ❌ Не авторизован");
      } else {
        console.log("Статус: ✅ Авторизован (куки сохранены)");
      }

      console.log("\n1 - Войти в DeepSeek (открыть браузер)");
      console.log("2 - Очистить сессию и выйти заново");
      console.log("3 - Запустить прокси (по умолчанию)");
      console.log("4 - Выход");

      let choice = await prompt("\nВаш выбор (Enter = 3): ");
      if (!choice) choice = "3";

      if (choice === "1") {
        await addAccountInteractive();
      } else if (choice === "2") {
        clearSession();
      } else if (choice === "3") {
        break;
      } else if (choice === "4") {
        console.log("До свидания!");
        process.exit(0);
      }
    }
    resolve();
  });
}

export async function startDeepSeekProxy() {
  logInfo("Запуск DeepSeek прокси...");

  await showAccountMenu();

  try {
    app.listen(port, host, () => {
      const displayHost = host === "0.0.0.0" ? "localhost" : host;
      console.log(`\n🚀 DeepSeek API запущен на http://${displayHost}:${port}`);
      logInfo(`API доступен по адресу: http://localhost:${port}/api/v1/chat/completions`);
      logInfo("Модели: deepseek-v3 (обычная), deepseek-r1 (thinking)");
    });
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      logError(`Порт ${port} уже используется.`);
      process.exit(1);
    }
    throw err;
  }
}

// Graceful shutdown
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("uncaughtException", (err) => { logError("Необработанное исключение", err); process.exit(1); });
