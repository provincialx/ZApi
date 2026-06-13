// index.js — Главный диспетчер. Выбор прокси-сервиса для запуска.
import { prompt } from "./shared/utils/prompt.js";

const SERVICES = [
  {
    id: "qwen",
    label: "Qwen (chat.qwen.ai) — Puppeteer/WAF bypass",
    entry: "./services/qwen/index.js",
  },
  {
    id: "deepseek",
    label: "DeepSeek (chat.deepseek.com) — Cookie/HTTP fetch",
    entry: "./services/deepseek/index.js",
  },
];

// Future services with stub implementation will be enabled here when ready.

async function main() {
  console.log(`
███████ ██████   ██████       ██████   █████  ██      ██████
██      ██   ██ ██    ██     ██    ██ ██   ██ ██     ██
█████   ██████  ██    ██     ██    ██ ███████ ██      █████
██      ██   ██ ██    ██     ██    ██ ██   ██ ██           ██
██      ██   ██  ██████       ██████  ██   ██ ██     ██████

================================================================================
  Локальный прокси к бесплатным AI-сервисам (OpenAI-compatible API)
  Выберите провайдер:
`);

  for (const [i, svc] of SERVICES.entries()) {
    console.log(`${i + 1} - ${svc.label}`);
  }

  const idx = Number.parseInt(
    await prompt(`\nВаш выбор (${SERVICES.map((_, i) => i + 1).join("/")})`),
    10
  );

  if (isNaN(idx) || idx < 1 || idx > SERVICES.length) {
    console.log("Некорректный выбор.");
    process.exit(1);
  }

  const service = SERVICES[idx - 1];
  console.log(`\n🚀 Запуск прокси: ${service.label}\n`);

  // Fork the service as a child process for process-level isolation
  const { fork } = await import("child_process");
  const path = await import("path");

  const servicePath = path.default.resolve(process.cwd(), service.entry);

  // Forward env vars to child, override LOGS_DIR for per-service log isolation
  const childEnv = {
    ...process.env,
    LOGS_DIR: "logs/" + service.id,
  };

  const child = fork(servicePath, [], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit", // Child shares stdin/stdout/stderr with parent (for interactive menu)
  });

  child.on("error", (err) => {
    console.error(`❌ Ошибка запуска прокси ${service.label}:`, err.message);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`\n⚡ Прокси остановлен сигналом: ${signal}`);
    } else if (code !== 0 && code !== null) {
      console.log(`\n⚠️ Прокси завершён с кодом: ${code}`);
      process.exit(code);
    }
  });

  // Forward termination signals to child
  ["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {
    process.on(sig, () => {
      console.log(`\n🛑 Передаю сигнал ${sig} прокси...`);
      try {
        child.kill(sig);
      } catch {
        // Child already exited
      }
    });
  });
}

main().catch((err) => {
  console.error("Ошибка запуска диспетчера:", err);
  process.exit(1);
});
