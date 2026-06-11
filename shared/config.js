// shared/config.js — Общие конфигурационные значения для всех прокси-сервисов
import dotenv from "dotenv";
dotenv.config();

export const PORT = process.env.PORT ?? "3264";
export const HOST = process.env.HOST || "0.0.0.0";

// ─── Logging ──────────────────────────────────────────────────────
export const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
export const LOG_MAX_SIZE = Number(process.env.LOG_MAX_SIZE ?? 5 * 1024 * 1024); // ~5MB
export const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES ?? 5);

// Logs directory — relative to project root (resolved at runtime)
export const LOGS_DIR = "freeqwenapi/logs";
