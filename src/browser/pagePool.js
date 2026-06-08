import { getBrowserContext } from "./browser.js";
import { saveAuthToken } from "./session.js";
import { logWarn, logDebug } from "../logger/index.js";
import { CHAT_PAGE_URL, PAGE_TIMEOUT, RETRY_DELAY, PAGE_POOL_SIZE } from "../config.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Page creation helper ────────────────────────────────────────────────────

/**
 * Creates a Puppeteer page. Handles both BrowserContext and Page inputs:
 * - If context has newPage() → calls it directly
 * - If passed a Page that supports browser() → creates new tab from same browser to avoid races
 * - Otherwise returns the Page itself (with closure safety check)
 */
export async function createPage(context) {
  if (context && typeof context.newPage === "function") {
    return await context.newPage();
  }

  if (context && typeof context.goto === "function") {
    // If passed a Puppeteer Page, don't reuse it as working page:
    // create a separate tab from the same browser to avoid races
    // and accidental closure of the base page.
    if (typeof context.browser === "function") {
      try {
        const browser = context.browser();
        if (browser && typeof browser.newPage === "function") {
          return await browser.newPage();
        }
      } catch (error) {
        logWarn(
          `Не удалось создать новую страницу из текущего контекста: ${error.message}`,
        );
      }
    }

    if (typeof context.isClosed === "function" && context.isClosed()) {
      throw new Error("Базовая страница браузера закрыта");
    }

    return context;
  }

  throw new Error(
    "Неверный контекст: не страница Puppeteer, не контекст Playwright",
  );
}

// ─── Evaluate with timeout helper ────────────────────────────────────────────
// page.evaluate без таймаута блокирует пул страниц бесконечно.
// Promise.race выбрасывает Error если CDP-соединение деградировало.
export const EVALUATE_HEALTH_TIMEOUT =
  Number(process.env.EVALUATE_HEALTH_TIMEOUT) || 5_000;

/**
 * Wraps page.evaluate() with a timeout via Promise.race.
 * Prevents CDP-dead pages from blocking the pool forever.
 */
export async function evaluateWithTimeout(
  page,
  fn,
  timeoutMs = EVALUATE_HEALTH_TIMEOUT,
) {
  return Promise.race([
    page.evaluate(fn),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`page.evaluate timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

// ─── Page Pool ────────────────────────────────────────────────────────────────

/**
 * Manages a pool of Chromium pages. Health-checks on checkout via evaluateWithTimeout.
 * Reuses pages to avoid expensive browser tab creation/teardown overhead.
 */
const pagePool = {
  pages: [],
  maxSize: PAGE_POOL_SIZE,

  /**
   * Acquires a working page from the pool or creates a new one.
   * Health-checks pooled pages; drops dead ones and creates fresh tabs on failure.
   * Retry goto up to 3 times with exponential backoff on network errors.
   */
  async getPage(context) {
    const baseContext = getBrowserContext();
    while (this.pages.length > 0) {
      const page = this.pages.pop();
      try {
        if (page === baseContext) {
          logWarn("Базовая страница не должна быть в пуле, пропускаем");
          continue;
        }
        if (page.isClosed()) {
          logWarn("Страница из пула закрыта, пропускаем");
          continue;
        }
        // Limit health-check timeout: if CDP connection degraded,
        // page dies quickly instead of hanging forever.
        await evaluateWithTimeout(page, () => document.readyState);
        return page;
      } catch (e) {
        logWarn(
          `Страница из пула протухла (${e.message?.substring(0, 60)}), создаём новую`,
        );
        if (page !== baseContext) {
          try {
            await page.close();
          } catch {
            /* already dead */
          }
        }
      }
    }

    const maxGotoAttempts = 3;
    let lastError;
    for (let attempt = 1; attempt <= maxGotoAttempts; attempt++) {
      try {
        const newPage = await createPage(context);
        await newPage.goto(CHAT_PAGE_URL, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_TIMEOUT,
        });

        // Extract token on fresh page if not yet cached.
        const currentToken = getAuthToken();
        if (!currentToken) {
          try {
            const newToken = await newPage.evaluate(() =>
              localStorage.getItem("token"),
            );
            if (newToken) {
              saveAuthToken(newToken);
              logDebug("Токен авторизации получен из новой страницы в пуле");
            }
          } catch (e) {
            // Token extraction failed on fresh page — not critical, token may be resolved later
          }
        }

        return newPage;
      } catch (e) {
        lastError = e;
        logWarn(
          `goto CHAT_PAGE_URL попытка ${attempt}/${maxGotoAttempts} не удалась: ${e.message?.substring(0, 80)}`,
        );
        if (attempt < maxGotoAttempts) {
          await delay(RETRY_DELAY * attempt); // exponential backoff
        }
      }
    }
    throw lastError;
  },

  /**
   * Returns a page to the pool for reuse. Skips closed pages and base context.
   */
  releasePage(page) {
    try {
      if (page.isClosed()) return;
    } catch {
      return;
    }

    const baseContext = getBrowserContext();
    if (page === baseContext) {
      // Keep base page separate from pool.
      return;
    }

    if (this.pages.length < this.maxSize) {
      this.pages.push(page);
    } else {
      import("../logger/index.js").then(({ logError }) => page.close().catch(logError));
    }
  },

  /**
   * Closes all pooled pages and clears the array. Used during auth restart / shutdown.
   */
  async clear() {
    const baseContext = getBrowserContext();
    for (const page of this.pages) {
      if (page === baseContext) continue;
      try {
        await page.close();
      } catch {
        /* ignore close errors during cleanup */
      }
    }
    this.pages = [];
  },

  /**
   * Returns pool stats for debugging/monitoring.
   */
  getStats() {
    return {
      size: this.pages.length,
      maxSize: this.maxSize,
    };
  },
};

export { pagePool };

/** @deprecated Use `getAuthToken()` from chat.js instead. Only for getPage token hint. */
let _authTokenGetter = () => null;
export function setAuthTokenGetter(fn) {
  _authTokenGetter = fn;
}
function getAuthToken() {
  return typeof _authTokenGetter === "function" ? _authTokenGetter() : null;
}
