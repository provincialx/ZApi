// mediaRoutes.js — Эндпоинты генерации изображений и видео (Qwen Chat / DashScope).
// Вынесено из routes.js для декомпозиции.

import express from "express";
import { sendMessage, extractMediaUrl, pollQwenTaskStatus } from "./chat.js";
import { getMappedModel } from "./modelMapping.js";
import {
  generateImage,
  getAvailableImageModels,
  checkImageApiAvailability,
} from "./imageGeneration.js";
import { listTokens } from "./tokenManager.js";
import { logInfo, logError, logDebug } from "../logger/index.js";
import { FORGETMEAI_WATERMARK } from "../utils/branding.js";

const router = express.Router();

const CHAT_MEDIA_MODEL = "qwen3-vl-plus";

function normalizeQwenAspectRatio(size, fallback = "16:9") {
  if (!size) return fallback;
  const value = String(size).trim();
  const ratioMap = {
    "1024x1024": "1:1",
    "512x512": "1:1",
    "768x768": "1:1",
    "960x960": "1:1",
    "1024x1792": "9:16",
    "1792x1024": "16:9",
    "1536x864": "16:9",
    "864x1536": "9:16",
  };
  if (ratioMap[value]) return ratioMap[value];
  if (/^\d+:\d+$/.test(value)) return value;
  return fallback;
}

function normalizeDashScopeSize(size) {
  const sizeMap = {
    "1024x1024": "1024*1024",
    "1024x1792": "1024*1792",
    "1792x1024": "1792*1024",
    "512x512": "512*512",
    "768x768": "768*768",
    "960x960": "960*960",
  };
  return sizeMap[size] || "1024*1024";
}

function buildOpenAiImageResponse({
  imageUrl,
  prompt,
  model,
  raw,
  provider = "qwen-chat",
}) {
  return {
    created: Math.floor(Date.now() / 1000),
    watermark: FORGETMEAI_WATERMARK,
    provider,
    model,
    data: [{ url: imageUrl, revised_prompt: prompt }],
    raw,
  };
}

function buildVideoResponse({ result, prompt, model, waitForCompletion }) {
  const videoUrl = result.video_url || extractMediaUrl(result, "video");
  return {
    id: result.id || result.task_id || `video-${Date.now()}`,
    object: videoUrl ? "video.generation" : "video.generation.task",
    created: Math.floor(Date.now() / 1000),
    watermark: FORGETMEAI_WATERMARK,
    provider: "qwen-chat",
    model,
    prompt,
    status: videoUrl ? "completed" : result.status || "processing",
    task_id: result.task_id || result.id || null,
    video_url: videoUrl || null,
    data: videoUrl ? [{ url: videoUrl }] : [],
    waitForCompletion,
    raw: result,
  };
}

/**
 * POST /images/generations
 * По умолчанию генерирует изображения через Qwen Chat (`chatType: t2i`).
 * Для старого DashScope-режима передайте `provider: "dashscope"`.
 */
router.post("/images/generations", async (req, res) => {
  try {
    const { prompt, model, n, size, response_format, provider } = req.body;

    logInfo("Получен запрос на генерацию изображения");
    logDebug(
      `Запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? "..." : ""}`,
    );

    if (!prompt) {
      return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
    }

    if (provider === "dashscope") {
      const apiKey = process.env.DASHSCOPE_API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "DashScope API генерации изображений не настроен",
          message:
            "Установите переменную окружения DASHSCOPE_API_KEY или используйте provider=qwen-chat",
        });
      }

      let imageModel = model || "qwen-image-plus";
      if (imageModel === "dall-e-3" || imageModel === "dall-e-2")
        imageModel = "qwen-image-plus";
      const result = await generateImage(prompt, imageModel, {
        n: n || 1,
        size: normalizeDashScopeSize(size),
        promptExtend: true,
        watermark: false,
      });

      if (result.error) {
        logError(`Ошибка генерации DashScope: ${result.error}`);
        return res.status(500).json({
          error: "Ошибка генерации изображения",
          message: result.error,
        });
      }

      return res.json(
        buildOpenAiImageResponse({
          imageUrl: result.imageUrl,
          prompt,
          model: imageModel,
          raw: result,
          provider: "dashscope",
        }),
      );
    }

    const chatModel = getMappedModel(model || CHAT_MEDIA_MODEL);
    const aspectRatio = normalizeQwenAspectRatio(
      size,
      req.body.aspect_ratio || "16:9",
    );
    const result = await sendMessage(
      prompt,
      chatModel,
      null,
      null,
      null,
      null,
      null,
      null,
      "t2i",
      aspectRatio,
      true,
    );

    if (result.error) {
      logError(`Ошибка генерации Qwen Chat image: ${result.error}`);
      return res.status(500).json({
        error: "Ошибка генерации изображения через Qwen Chat",
        message: result.error,
        details: result.details,
      });
    }

    const imageUrl =
      extractMediaUrl(result, "image") ||
      result.choices?.[0]?.message?.content ||
      null;
    if (!imageUrl) {
      return res.status(502).json({
        error: "Qwen Chat не вернул URL изображения",
        raw: result,
      });
    }

    logInfo(`Изображение Qwen Chat сгенерировано: ${imageUrl}`);
    return res.json(
      buildOpenAiImageResponse({
        imageUrl,
        prompt,
        model: chatModel,
        raw: result,
      }),
    );
  } catch (error) {
    logError("Ошибка при генерации изображения", error);
    res
      .status(500)
      .json({ error: "Внутренняя ошибка сервера", message: error.message });
  }
});

/**
 * POST /videos/generations - Генерация видео через Qwen Chat (`chatType: t2v`).
 */
router.post("/videos/generations", async (req, res) => {
  try {
    const { prompt, model, size, wait, waitForCompletion } = req.body;
    const shouldWait = waitForCompletion ?? wait ?? true;

    logInfo("Получен запрос на генерацию видео через Qwen Chat");
    logDebug(
      `Видео-запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? "..." : ""}`,
    );

    if (!prompt) {
      return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
    }

    const chatModel = getMappedModel(model || CHAT_MEDIA_MODEL);
    const aspectRatio = normalizeQwenAspectRatio(
      size,
      req.body.aspect_ratio || "16:9",
    );
    const result = await sendMessage(
      prompt,
      chatModel,
      null,
      null,
      null,
      null,
      null,
      null,
      "t2v",
      aspectRatio,
      shouldWait,
    );

    if (result.error) {
      logError(`Ошибка генерации Qwen Chat video: ${result.error}`);
      return res.status(500).json({
        error: "Ошибка генерации видео через Qwen Chat",
        message: result.error,
        details: result.details,
        task_id: result.task_id,
      });
    }

    const response = buildVideoResponse({
      result,
      prompt,
      model: chatModel,
      waitForCompletion: shouldWait,
    });
    logInfo(
      response.video_url
        ? `Видео Qwen Chat сгенерировано: ${response.video_url}`
        : `Видео-задача создана: ${response.task_id}`,
    );
    return res.json(response);
  } catch (error) {
    logError("Ошибка при генерации видео", error);
    res
      .status(500)
      .json({ error: "Внутренняя ошибка сервера", message: error.message });
  }
});

/**
 * GET /tasks/status/:taskId - статус долгой задачи Qwen Chat.
 */
router.get("/tasks/status/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;
    const wait = ["1", "true", "yes"].includes(
      String(req.query.wait || "").toLowerCase(),
    );
    if (!taskId) return res.status(400).json({ error: "taskId обязателен" });

    const result = await pollQwenTaskStatus(taskId, wait);
    if (result.error && !result.data) {
      return res.status(500).json(result);
    }
    return res.json({ watermark: FORGETMEAI_WATERMARK, ...result });
  } catch (error) {
    logError("Ошибка при проверке статуса задачи", error);
    res
      .status(500)
      .json({ error: "Внутренняя ошибка сервера", message: error.message });
  }
});

/**
 * GET /images/models - модели для генерации изображений.
 */
router.get("/images/models", async (req, res) => {
  try {
    const dashScopeModels = getAvailableImageModels();
    res.json({
      object: "list",
      watermark: FORGETMEAI_WATERMARK,
      data: [
        {
          id: CHAT_MEDIA_MODEL,
          object: "model",
          created: Date.now(),
          owned_by: "qwen-chat",
          permission: [],
          capability: "qwen_chat_image_generation",
          provider: "qwen-chat",
        },
        ...dashScopeModels.map((model) => ({
          id: model,
          object: "model",
          created: Date.now(),
          owned_by: "qwen",
          permission: [],
          capability: "image_generation",
          provider: "dashscope",
        })),
      ],
    });
  } catch (error) {
    logError("Ошибка при получении списка моделей изображений", error);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

/**
 * GET /videos/models - модели для генерации видео через Qwen Chat.
 */
router.get("/videos/models", (req, res) => {
  res.json({
    object: "list",
    watermark: FORGETMEAI_WATERMARK,
    data: [
      {
        id: CHAT_MEDIA_MODEL,
        object: "model",
        created: Date.now(),
        owned_by: "qwen-chat",
        permission: [],
        capability: "qwen_chat_video_generation",
        provider: "qwen-chat",
      },
    ],
  });
});

/**
 * GET /images/status - Проверка статуса генерации изображений.
 */
router.get("/images/status", async (req, res) => {
  try {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const dashScopeAvailable = await checkImageApiAvailability();
    const tokens = listTokens();
    const now = Date.now();
    const qwenChatAvailable = tokens.some(
      (t) => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid,
    );

    res.json({
      watermark: FORGETMEAI_WATERMARK,
      qwenChat: {
        available: qwenChatAvailable,
        model: CHAT_MEDIA_MODEL,
        message: qwenChatAvailable
          ? "Qwen Chat генерация изображений доступна"
          : "Нет активных аккаунтов Qwen Chat",
      },
      dashscope: {
        available: dashScopeAvailable,
        apiKeyConfigured: !!apiKey,
        message: dashScopeAvailable
          ? "DashScope API генерации изображений доступен"
          : apiKey
            ? "DashScope API недоступен или неверные учётные данные"
            : "DASHSCOPE_API_KEY не настроен",
      },
    });
  } catch (error) {
    logError("Ошибка при проверке статуса API изображений", error);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

/**
 * GET /videos/status - Проверка готовности видео-генерации Qwen Chat.
 */
router.get("/videos/status", (req, res) => {
  const tokens = listTokens();
  const now = Date.now();
  const availableAccounts = tokens.filter(
    (t) => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid,
  ).length;
  res.json({
    watermark: FORGETMEAI_WATERMARK,
    available: availableAccounts > 0,
    model: CHAT_MEDIA_MODEL,
    accounts: { total: tokens.length, available: availableAccounts },
    message:
      availableAccounts > 0
        ? "Qwen Chat генерация видео доступна"
        : "Нет активных аккаунтов Qwen Chat",
  });
});

export default router;
