import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  initBrowser,
  shutdownBrowser,
  getBrowserContext,
  restartBrowserInHeadlessMode,
} from "../browser/browser.js";
import { extractAuthToken } from "../api/chat.js";
import { loadTokens, saveTokens, markValid, removeToken } from "../api/tokenManager.js";
import { clearSession, loadSession, saveAuthToken, loadAuthToken } from "../browser/session.js";
import { logInfo, logError, logWarn } from "../../../shared/logger/index.js";
import { prompt } from "../../../shared/utils/prompt.js";
import { formatContactInfo } from "./branding.js";
import { CHAT_PAGE_URL } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureAccountDir(id) {
  const accountDir = path.resolve(__dirname, "..", "..", "session", "accounts", id);
  if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });
  return accountDir;
}

// ──────────────────────────────────────────────────────────────────────────────
// Button 1: Add new account (fresh unique ID)
// - Clears global token file so old sessions don't bleed in.
// - Opens visible browser for manual login.
// - Saves cookies + token to the NEW directory only.
// ──────────────────────────────────────────────────────────────────────────────
export async function addAccountInteractive() {
  logInfo("======================================================");
  logInfo("Добавление нового аккаунта Qwen (с нуля)");
  logInfo(formatContactInfo());
  logInfo("Браузер откроется. Войдите в систему, затем вернитесь и нажмите ENTER.");
  logInfo("======================================================");

  // Avoid mixing up with the previous global fallback token file during add flow.
  try {
    loadAuthToken();
  } catch {}
  // Clear it explicitly so extractAuthToken doesn't lie about "found old token".
  fs.writeFileSync(path.resolve(__dirname, "..", "..", "session", "auth_token.txt"), "", "utf8");

  const ok = await initBrowser(true, true); // visible + skipManualAuth prompt (we do it manually below)
  if (!ok) {
    logError("Не удалось запустить браузер.");
    return null;
  }

  try {
    const ctx = getBrowserContext();

    // Navigate directly to Qwen so user logs into the right place.
    await ctx.goto(CHAT_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await delay(2000);

    console.log("\n------------------------------------------------------");
    console.log("               ОЖИДАНИЕ ВХОДА В СИСТЕМУ");
    console.log("------------------------------------------------------");
    console.log("1. Войдите через GitHub / Email в открытом браузере.");
    console.log("2. После входа вернитесь сюда и нажмите ENTER.");
    console.log("------------------------------------------------------\n");

    await prompt("Нажмите ENTER после успешной авторизации...");
    logInfo("Вход подтверждён пользователем, извлекаю токен...");

    // Give Qwen a moment to finalize redirects after Enter.
    await delay(2000);

    const token = await extractAuthToken(ctx, true); // forceRefresh = true
    if (!token) {
      logError("Токен не был получен после входа.");
      return null;
    }

    // Save global auth_token.txt for the main proxy loop to pick up later.
    saveAuthToken(token);

    const id = "acc_" + Date.now();
    ensureAccountDir(id);

    // Save per-account token backup
    fs.writeFileSync(
      path.join(__dirname, "..", "..", "session", "accounts", id, "token.txt"),
      token,
      "utf8"
    );

    // Update in-memory + disk tokenManager list
    const list = loadTokens();
    list.push({ id, token, resetAt: null });
    saveTokens(list);

    logInfo(`Аккаунт '${id}' добавлен. Всего аккаунтов: ${list.length}`);
  } catch (e) {
    logError("Ошибка при добавлении аккаунта", e);
  } finally {
    await shutdownBrowser();
    // Restart headless with fresh cookies from global file if needed, or just return to menu.
    await initBrowser(false);
  }

  logInfo("======================================================");
}

// ──────────────────────────────────────────────────────────────────────────────
// Button 2: Relogin invalid/expired account (restore specific ID)
// - Loads saved cookies FIRST so browser starts authenticated.
// - If cookies dead -> manual login screen appears for the user.
// - Saves NEW cookies + updates tokenManager list.
// ──────────────────────────────────────────────────────────────────────────────
export async function reloginAccountInteractive() {
  const tokens = loadTokens();
  // Allow picking ANY account to force refresh, not just invalid ones.
  if (!tokens.length) {
    console.log("Нет сохранённых аккаунтов для перелогина.");
    await prompt("Нажмите ENTER чтобы вернуться в меню...");
    return;
  }

  console.log("\nДоступные аккаунты:");
  tokens.forEach((t, idx) => {
    const status = t.invalid ? " (Invalid)" : "";
    if (t.resetAt) status += ` (Cooldown until ${new Date(t.resetAt).toLocaleTimeString()})`;
    console.log(`${idx + 1} - ${t.id}${status}`);
  });

  const choice = await prompt("Выберите номер аккаунта для перелогина: ");
  const num = parseInt(choice, 10);

  if (isNaN(num) || num < 1 || num > tokens.length) {
    console.log("Неверный выбор.");
    return;
  }

  const account = tokens[num - 1];
  logInfo(`Перелогин аккаунта: ${account.id}`);

  await shutdownBrowser(); // Close existing headless session cleanly.

  const ok = await initBrowser(true, true); // visible browser
  if (!ok) {
    logError("Не удалось запустить браузер для перелога.");
    return;
  }

  try {
    const ctx = getBrowserContext();

    // TRY to load saved cookies for this specific account before navigating.
    // This prevents the user from having to type passwords if cookies are still alive!
    const cookiePath = path.join(
      __dirname,
      "..",
      "..",
      "session",
      "accounts",
      account.id,
      "cookies.json"
    );
    if (fs.existsSync(cookiePath)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(cookiePath, "utf8"));
        await ctx.setCookie(...cookies);
        logInfo(
          `Куки для ${account.id} загружены (${cookies.length}). Пробую восстановить сессию...`
        );
      } catch (e) {
        logWarn("Не удалось загрузить куки для этого аккаунта.");
      }
    }

    await ctx.goto(CHAT_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await delay(2000);

    // Check if we are actually logged in after loading cookies.
    const token = await extractAuthToken(ctx, true);

    let needsManualLogin = !token;

    if (!needsManualLogin) {
      console.log("\n------------------------------------------------------");
      console.log("               АВТОМАТИЧЕСКОЕ ВОССТАНОВЛЕНИЕ СДЕЛАНО");
      console.log("------------------------------------------------------");
      console.log("Куки живы! Токен обновлён автоматически.");
      console.log("Нажмите ENTER для завершения...");
      console.log("------------------------------------------------------\n");
    } else {
      console.log("\n------------------------------------------------------");
      console.log("               РУЧНОЙ ВХОД (Сессия просрочена)");
      console.log("------------------------------------------------------");
      console.log("1. Войдите через GitHub / Email в открытом браузере.");
      console.log("2. После входа вернитесь сюда и нажмите ENTER.");
      console.log("------------------------------------------------------\n");

      await prompt("Нажмите ENTER после успешной авторизации...");
      logInfo("Вход подтверждён пользователем, извлекаю новый токен...");
      await delay(2000);

      // Extract again now that user actually typed their creds.
      const freshToken = await extractAuthToken(ctx, true);
      if (freshToken) {
        markValid(account.id, freshToken);
        logInfo(`Токен обновлён для ${account.id}`);
      } else {
        throw new Error("Не удалось получить токен даже после ручного входа.");
      }

      saveAuthToken(freshToken); // Update global for proxy loop.
    }

    // ALWAYS overwrite cookies.json after a successful relgoin to keep them fresh!
    const freshCookies = await ctx.cookies();
    ensureAccountDir(account.id);
    fs.writeFileSync(cookiePath, JSON.stringify(freshCookies, null, 2));
    logInfo(`Свежие куки сохранены для ${account.id}`);

    saveTokens(loadTokens()); // Persist updated token/invalid state.

    console.log("------------------------------------------------------");
    console.log("Аккаунт восстановлен и готов к работе!");
    console.log("Нажмите ENTER чтобы перезапустить браузер в фоновом режиме...");
    console.log("------------------------------------------------------\n");
    await prompt("ENTER для продолжения...");
  } catch (e) {
    logError(`Ошибка при перелогине аккаунта ${account.id}`, e);
  } finally {
    // Always switch back to invisible background browser after relgoin.
    await restartBrowserInHeadlessMode();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Button 4: Remove account (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
export async function removeAccountInteractive() {
  const tokens = loadTokens();
  if (!tokens.length) {
    console.log("Нет сохранённых аккаунтов.");
    await prompt("ENTER чтобы вернуться...");
    return;
  }

  console.log("\nДоступные аккаунты:");
  tokens.forEach((t, idx) => console.log(`${idx + 1} - ${t.id}`));

  const choice = await prompt("Номер аккаунта для удаления (или ENTER для отмены): ");
  if (!choice) return;

  const num = parseInt(choice, 10);
  if (isNaN(num) || num < 1 || num > tokens.length) {
    console.log("Неверный выбор.");
    await prompt("ENTER чтобы вернуться...");
    return;
  }

  const acc = tokens[num - 1];
  const confirm = await prompt(`Точно удалить ${acc.id}? (y/N): `);
  if (confirm.toLowerCase() !== "y") return;

  removeToken(acc.id);

  // Delete local folder too.
  const dir = path.resolve(__dirname, "..", "..", "session", "accounts", acc.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  logInfo(`Аккаунт ${acc.id} удалён.`);
  await prompt("ENTER чтобы вернуться...");
}

export default { addAccountInteractive, reloginAccountInteractive, removeAccountInteractive };
