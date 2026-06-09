import { REQUEST_TIMEOUT_MINUTES } from "../config.js";

/**
 * Wraps a Promise with an AbortController signal that fires after REQUEST_TIMEOUT_MINUTES.
 * Returns the result or throws on timeout. Callers should catch the TimeoutError.
 */
export function withRequestTimeout(promise, label = "request") {
  const ms = REQUEST_TIMEOUT_MINUTES * 60_000;

  let abortTimer = null;
  const abortPromise = new Promise((_, reject) => {
    abortTimer = setTimeout(
      () => reject(new Error(`⏱ Timeout after ${REQUEST_TIMEOUT_MINUTES}m (${label})`)),
      ms,
    );
  });

  return Promise.race([promise, abortPromise]).finally(() => {
    clearTimeout(abortTimer);
  });
}
