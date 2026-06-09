// debug-trace.js — трассировка КАЖДОГО шага обработки запроса к /chat/completions
// Включает тайминги на каждом этапе. Убрать когда не нужно.

import { logInfo, logError, logWarn } from "./logger/index.js";

export function requestTracer() {
  return (req, res, next) => {
    // Только для chat/completions — не спамим на health/models
    if (!req.url.includes("chat")) return next();

    const start = Date.now();
    const method = req.method;
    const url = req.originalUrl || req.url;
    logInfo(`▶ [TRACE] ${method} ${url} | body keys: ${Object.keys(req.body || {}).join(",")}`);

    // Intercept res.json to capture timing + result shape
    const origJson = res.json.bind(res);
    res.json = (body) => {
      const elapsed = Date.now() - start;
      const status = res.statusCode;

      if (typeof body === "object" && body !== null) {
        const hasError = !!body.error;
        const hasChoices = !!body.choices?.length;
        const contentLen = body.choices?.[0]?.message?.content?.length || 0;

        logInfo(
          `◀ [TRACE] ${status} in ${elapsed}ms | error=${hasError} choices=${hasChoices ? `[${body.choices.length}]` : "none"} content_len=${contentLen}`
        );

        if (hasError) {
          logError(`  ❌ ERROR: ${JSON.stringify(body.error).substring(0, 300)}`);
        } else if (!hasChoices && !res.headersSent) {
          logWarn(`  ⚠️ Ответ без choices. Body keys: ${Object.keys(body).join(",")}`);
        }
      }

      return origJson(body);
    };

    // Intercept res.write (streaming) to capture first chunk timing
    const origWrite = res.write.bind(res);
    let firstChunkLogged = false;
    res.write = (chunk) => {
      if (!firstChunkLogged && typeof chunk === "string" && chunk.includes("data:")) {
        const elapsed = Date.now() - start;
        logInfo(`◀ [TRACE] First SSE chunk after ${elapsed}ms`);
        firstChunkLogged = true;
      }
      return origWrite(chunk);
    };

    // Intercept res.end to capture total response time for streams
    const origEnd = res.end.bind(res);
    res.end = (chunk) => {
      const elapsed = Date.now() - start;
      logInfo(`◀ [TRACE] Response finished after ${elapsed}ms | status=${res.statusCode}`);
      return origEnd(chunk);
    };

    next();
  };
}
