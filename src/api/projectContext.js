// projectContext.js — Auto-inject актуального состояния проекта в запросы-аудит.
// Когда модель галлюцинирует из training data, этот модуль сканирует реальную файловую систему
// и инжектирует свежий контекст.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logDebug } from "../logger/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Корень проекта — вверх от src/api/projectContext.js → project root
export const PROJECT_ROOT = path.resolve(__dirname, "../../..");

// Директории и файлы для исключения из сканирования
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "session",
  "logs",
  "uploads",
]);

const EXCLUDED_FILES = new Set(["package-lock.json"]);

const WHITELISTED_DOTFILES = new Set([
  ".gitignore",
  ".agent-brief.md",
  ".rules",
]);

// Ключевые слова, указывающие на запрос аудита/анализа структуры проекта
const AUDIT_KEYWORDS = [
  // Русские
  /аудит(?:.*проект|.*код|.*структур)?/i,
  /проверь.*(структур|файл|проект|что есть)/i,
  /посмотри.*(файл|директор|структуру|проект)/i,
  /какие.*файл/i,
  /анализ(ир)?\s*(код|проект|структур)/i,
  // Общие
  /техдолг|techdebt|technical\s*debt/i,
  /what\s+(files?)?\s+are.*in.*(project|codebase)/i,
  /structure\s+(of)?\s*(this\s*)?(project|codebase)?/i,
  // Контекстные — "покажи что у меня" (без training data)
  /(?:(?:look over|scan|review|walk through)\s+(the )?)?(codebase|directory|folder structure)/i,
  /(?:list|show me|tell me).*files?/i,
];

/**
 * Рекурсивно сканирует директорию и возвращает tree-like string.
 */
function scanDirectory(dir, prefix = "", isLast = true, depth = 0) {
  if (depth > 4) return ""; // Ограничение глубины для производительности

  let result = "";
  try {
    const entries = fs.readdirSync(dir);
    const filteredEntries = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stats = fs.statSync(fullPath);

      if (stats.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry)) {
          filteredEntries.push({ name: `${entry}/`, isDir: true });
        }
      } else {
        // Regular files: skip if in EXCLUDED_FILES or is a dotfile not in whitelist
        if (
          !EXCLUDED_FILES.has(entry) &&
          (!entry.startsWith(".") || WHITELISTED_DOTFILES.has(entry))
        ) {
          filteredEntries.push({ name: entry, isDir: false });
        }
      }
    }

    // Файлы идут первыми, папки вторыми
    const files = filteredEntries.filter((e) => !e.isDir);
    const dirs = filteredEntries.filter((e) => e.isDir);
    const sorted = [...files, ...dirs];

    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      const lastOne = i === sorted.length - 1;
      const connector = lastOne ? "└── " : "├── ";
      result += prefix + connector + item.name + "\n";

      if (item.isDir) {
        const newPrefix = prefix + (lastOne ? "    " : "│   ");
        const subResult = scanDirectory(
          path.join(dir, item.name.replace("/", "")),
          newPrefix,
          lastOne,
          depth + 1,
        );
        result += subResult;
      }
    }
  } catch (err) {
    logDebug(`projectContext: scan error at ${dir}: ${err.message}`);
  }

  return result;
}

/**
 * Проверка содержит ли текст ключевые слова аудита.
 */
export function isAuditRequest(messages) {
  const texts = [];

  if (!messages || !Array.isArray(messages)) return false;

  for (const msg of messages) {
    if (!msg) continue;

    if (typeof msg.content === "string") {
      texts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && typeof part.text === "string") {
          texts.push(part.text);
        }
      }
    }
  }

  const combinedText = texts.join("\n");

  return AUDIT_KEYWORDS.some((regex) => regex.test(combinedText));
}

/**
 * Сканирует проект и возвращает актуальную структуру.
 */
export function getProjectStructure() {
  const tree = scanDirectory(PROJECT_ROOT);
  const count = (tree.match(/├──|└──/g) || []).length;

  return `---PROJECT STRUCTURE (real-time, ${count} items)---\n${tree}`;
}

/**
 * Генерирует system instruction для предотвращения галлюцинаций.
 * Возвращает null если запрос не содержит audit-ключевых слов.
 */
export function buildAuditContext(messages) {
  if (!isAuditRequest(messages)) return null;

  const structure = getProjectStructure();

  const contextBlock = `---CRITICAL INSTRUCTION---
The user is asking about THIS project's structure. Below is the REAL, current file system state.
DO NOT rely on training data or memory of what this project "usually" looks like.
Use ONLY the structure below to answer questions about files, folders, and tech debt.

${structure}
---END PROJECT STRUCTURE---`;

  logDebug(
    `[PROJECT CONTEXT] Audit keywords detected. Injecting real project state.`,
  );

  return contextBlock;
}
