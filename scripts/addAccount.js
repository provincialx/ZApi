// Скрипт interactively добавляет новые аккаунты Qwen.
// Запуск: node scripts/addAccount.js

import { addAccountInteractive } from "../services/qwen/utils/accountSetup.js";

(async () => {
  await addAccountInteractive();
})();
