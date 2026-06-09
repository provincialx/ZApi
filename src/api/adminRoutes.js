// adminRoutes.js — Сервисные эндпоинты: health, models, status, chats.
// Вынесено из routes.js для декомпозиции.

import express from "express";
import { getAllModels, createChatV2, testToken } from "./chat.js";
import { getAuthenticationStatus, getBrowserContext } from "../browser/browser.js";
import { checkAuthentication } from "../browser/auth.js";
import { logInfo, logError } from "../logger/index.js";
import { getMappedModel } from "./modelMapping.js";
import { DEFAULT_MODEL } from "../config.js";
import { listTokens, markInvalid, markRateLimited, markValid } from "./tokenManager.js";
import { FORGETMEAI_WATERMARK } from "../utils/branding.js";

const router = express.Router();

router.get("/health", async (req, res) => {
  try {
    const modelData = getAllModels();
    const tokens = listTokens();
    const now = Date.now();
    const availableAccounts = tokens.filter(
      (t) => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid
    ).length;

    res.json({
      ok: availableAccounts > 0,
      service: "FreeQwenApi",
      watermark: FORGETMEAI_WATERMARK,
      baseUrl: "/api",
      models: modelData.models.length,
      accounts: {
        total: tokens.length,
        available: availableAccounts,
        invalid: tokens.filter((t) => t.invalid).length,
        waiting: tokens.filter((t) => t.resetAt && new Date(t.resetAt).getTime() > now).length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError("Ошибка health check", error);
    res.status(500).json({ ok: false, error: "Health-проверка не удалась" });
  }
});

router.get("/models", async (req, res) => {
  try {
    logInfo("Запрос на получение списка моделей");
    const modelsRaw = getAllModels();
    const openAiModels = {
      object: "list",
      data: modelsRaw.models.map((m) => ({
        id: m.id || m.name || m,
        object: "model",
        created: 0,
        owned_by: "qwen",
        permission: [],
      })),
    };
    logInfo(`Возвращено ${openAiModels.data.length} моделей (OpenAI формат)`);
    res.json(openAiModels);
  } catch (error) {
    logError("Ошибка при получении списка моделей", error);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.get("/status", async (req, res) => {
  try {
    logInfo("Запрос статуса авторизации");
    const tokens = listTokens();
    const accounts = await Promise.all(
      tokens.map(async (t) => {
        const accInfo = {
          id: t.id,
          status: "UNKNOWN",
          resetAt: t.resetAt || null,
        };

        if (t.resetAt) {
          const resetTime = new Date(t.resetAt).getTime();
          if (resetTime > Date.now()) {
            accInfo.status = "WAIT";
            return accInfo;
          }
        }

        const testResult = await testToken(t.token);
        if (testResult === "OK") {
          accInfo.status = "OK";
          if (t.invalid || t.resetAt) markValid(t.id);
        } else if (testResult === "RATELIMIT") {
          accInfo.status = "WAIT";
          markRateLimited(t.id, 24);
        } else if (testResult === "UNAUTHORIZED") {
          accInfo.status = "INVALID";
          if (!t.invalid) markInvalid(t.id);
        } else {
          accInfo.status = "ERROR";
        }
        return accInfo;
      })
    );

    const browserContext = getBrowserContext();
    if (!browserContext) {
      logError("Браузер не инициализирован");
      return res.json({
        authenticated: false,
        message: "Браузер не инициализирован",
        accounts,
      });
    }

    if (getAuthenticationStatus()) return res.json({ accounts });

    await checkAuthentication(browserContext);
    const isAuthenticated = getAuthenticationStatus();
    logInfo(`Статус авторизации: ${isAuthenticated ? "активна" : "требуется авторизация"}`);
    res.json({
      authenticated: isAuthenticated,
      message: isAuthenticated ? "Авторизация активна" : "Требуется авторизация",
      accounts,
    });
  } catch (error) {
    logError("Ошибка при проверке статуса авторизации", error);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.post("/chats", async (req, res) => {
  try {
    const { name, model } = req.body;
    const chatModel = model ? getMappedModel(model) : DEFAULT_MODEL;
    logInfo(`Создание нового чата${name ? ` с именем: ${name}` : ""}, модель: ${chatModel}`);
    const result = await createChatV2(chatModel, name || "Новый чат");
    if (result.error) {
      logError(`Ошибка создания чата: ${result.error}`);
      return res.status(500).json({ error: result.error });
    }
    logInfo(`Создан новый чат v2 с ID: ${result.chatId}`);
    res.json({ chatId: result.chatId, success: true });
  } catch (error) {
    logError("Ошибка при создании чата", error);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

export default router;
