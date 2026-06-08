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
// Cache: scan once per process lifetime (project structure changes rarely)
let _cachedStructure = null;
const CACHE_TTL = 30_000; // 30s
let _cacheTime = 0;

function getProjectStructureCached() {
  const now = Date.now();
  if (_cachedStructure && now - _cacheTime < CACHE_TTL) return _cachedStructure;
  const tree = scanDirectory(PROJECT_ROOT);
  const count = (tree.match(/├──|└──/g) || []).length;
  _cachedStructure = `---PROJECT STRUCTURE (${count} items, real-time scan at ${new Date().toISOString()})---\n${tree}`;
  _cacheTime = now;
  return _cachedStructure;
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
 * Всегда инжектирует актуальное состояние проекта в system message.
 * Anti-hallucination: модель не может угадать структуру из training data,
 * потому что видит реальный снимок файловой системы.
 */
export function buildProjectContext() {
  const structure = getProjectStructureCached();

  return `---PROJECT CONTEXT (REAL FILE SYSTEM STATE)---
The user is working with THIS project. Below is the ACTUAL, current file system state.
DO NOT answer from training data about what this project "used to have" or "should have".
Only reference files and directories that appear in the structure below.
If a file is not listed, it does not exist in this project.

${structure}
---END PROJECT CONTEXT---`;
}
