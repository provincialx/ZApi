// services/deepseek/browser/auth.js — Cookie extraction via Puppeteer
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import { logInfo, logError, logWarn } from "../../../shared/logger/index.js";
import { CHAT_PAGE_URL, PAGE_TIMEOUT } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Session storage paths (relative to project root: services -> FreeQwenApi)
const SESSION_PATH = path.resolve(__dirname, "..", "..", "session");
const COOKIES_FILE = path.join(SESSION_PATH, "cookies.json");
const STORAGE_FILE = path.join(SESSION_PATH, "storage.json");

puppeteer.use(StealthPlugin());

let globalBrowser = null;

export async function initAuthBrowser() {
  if (globalBrowser) return true;

  try {
    logInfo("Запуск браузера для авторизации DeepSeek...");

    const browser = await puppeteer.launch({
      headless: false, // Must be visible for login + CAPTCHA solving
      args: ["--no-sandbox"],
      defaultViewport: null,
    });

    globalBrowser = browser;
    return true;
  } catch (err) {
    logError("Ошибка запуска браузера DeepSeek", err);
    return false;
  }
}

export async function shutdownAuthBrowser() {
  if (!globalBrowser) return;

  try {
    // Try to save cookies before closing in case they changed
    const pages = globalBrowser.pages();
    for (const page of pages) {
      try {
        await extractSession(page);
      } catch {}
    }
  } finally {
    await globalBrowser.close().catch(() => {});
    globalBrowser = null;
    logInfo("Браузер DeepSeek закрыт");
  }
}

async function extractSession(page) {
  try {
    // Extract cookies (including cf_clearance and session cookies)
    const cookies = await page.cookies(CHAT_PAGE_URL);
    if (!cookies.length) return false;

    fs.mkdirSync(SESSION_PATH, { recursive: true });
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2), "utf8");

    // Extract localStorage + sessionStorage (critical for DeepSeek auth)
    const storage = await page.evaluate(() => {
      const result = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          result[key] = localStorage.getItem(key);
        }
      } catch {}

      try {
        const sessionKeys = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          sessionKeys.push([key, sessionStorage.getItem(key)]);
        }
        result["sessionStorage"] = Object.fromEntries(sessionKeys);
      } catch {}

      return result;
    });

    if (storage && Object.keys(storage).length > 0) {
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(storage, null, 2), "utf8");
      logInfo("Cookies и storage извлечены для DeepSeek");
    } else {
      return false;
    }

    return true;
  } catch (err) {
    logError("Ошибка извлечения сессии DeepSeek", err);
    return false;
  }
}

export async function addAccountInteractive() {
  const ok = await initAuthBrowser();
  if (!ok) {
    logError("Не удалось запустить браузер.");
    return null;
  }

  try {
    globalBrowser.pages().forEach((p) => p.close());

    const page = await globalBrowser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(CHAT_PAGE_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });

    console.log("\n------------------------------------------------------");
    console.log("               ОЖИДАНИЕ ВХОДА В DEEPSEEK");
    console.log("------------------------------------------------------");
    console.log("1. Нажмите Login в правом верхнем углу.");
    console.log("2. Войдите через GitHub / Google в браузере.");
    console.log("3. После входа нажмите ENTER здесь.");
    console.log("------------------------------------------------------\n");

    const { prompt } = await import("../../../shared/utils/prompt.js");
    await prompt("Нажмите ENTER после успешной авторизации...");
    logInfo("Вход подтверждён, извлекаю сессию...");

    // Wait for page to stabilize after login redirect
    await new Promise((r) => setTimeout(r, 3000));

    const extracted = await extractSession(page);
    if (!extracted) {
      logWarn("Не удалось извлечь cookie. Возможно, вход не прошёл.");
      return null;
    }

    console.log("\n------------------------------------------------------");
    console.log("✅ Сессия DeepSeek сохранена!");
    console.log("Нажмите ENTER для закрытия браузера...");
    console.log("------------------------------------------------------\n");
    await prompt("ENTER для продолжения...");

    return { success: true };
  } catch (e) {
    logError("Ошибка при добавлении аккаунта DeepSeek", e);
    return null;
  } finally {
    await shutdownAuthBrowser();
  }
}

export function getStoredCookies() {
  if (!fs.existsSync(COOKIES_FILE)) return [];
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
    if (Array.isArray(cookies) && cookies.length > 0) return cookies;
  } catch {}
  return [];
}

export function hasValidSession() {
  const cookies = getStoredCookies();
  if (!cookies.length) return false;

  // Check for session cookie or cf_clearance
  const sessionCookies = ["__cf_bm", "cf_clearance"];
  return cookies.some((c) => sessionCookies.includes(c.name));
}

export function clearSession() {
  try {
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    if (fs.existsSync(STORAGE_FILE)) fs.unlinkSync(STORAGE_FILE);
    logInfo("Сессия DeepSeek очищена");
  } catch {}
}
