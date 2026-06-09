// Add tracing to chat.js sendMessage - no template literals in replacement text
import fs from "fs";

const content = fs.readFileSync("src/api/chat.js", "utf8");
if (content.includes("_trace0")) {
  console.log("[add-logging] Already patched.");
  process.exit(0);
}

// Handle both LF and CRLF
const originalLF = [
  ") {",
  "  if (!availableModels) availableModels = getAvailableModelsFromFile();",
  "",
  "  if (!chatId) {",
].join("\n");

// Try with actual line endings from file
let original = originalLF;
if (content.includes(originalLF)) {
  // good
} else if (content.indexOf(") {\r\n  if (!availableModels)") >= 0) {
  original = [
    ") {",
    "  if (!availableModels) availableModels = getAvailableModelsFromFile();",
    "",
    "  if (!chatId) {",
  ].join("\r\n");
}

// eslint-disable-next-line no-undef
const replacement = replacementLines.join("\n");

let patched = content.replace(original, replacement);

// Additional replacements - simple string insertions before/after existing lines
patched = patched.replace(
  "    logInfo(`Создан новый чат v2 с ID: ${chatId}`);",
  '    _ts("Chat created", `id=${chatId}`);' // literal template in target code
);

patched = patched.replace(
  "  const validated = validateAndPrepareMessage(message);",
  '_ts("Validating message");\n  const validated = validateAndPrepareMessage(message);'
);

patched = patched.replace(
  '  logInfo(`Используемая модель: "${model}"`);',
  '_ts("Using model", `"${model}"`);' // literal template in target code
);

patched = patched.replace(
  "  const browserContext = getBrowserContext();",
  '_ts("Getting browser context");\n  const browserContext = getBrowserContext();'
);

patched = patched.replace(
  '  if (!browserContext) return { error: "Браузер не инициализирован", chatId };',
  '  if (!browserContext) {\n    _ts("ERROR: Browser not initialized");\n    return { error: "Браузер не инициализирован", chatId };\n  }'
);

patched = patched.replace(
  "  const tokenObj = await resolveAuthToken(browserContext);",
  '_ts("Resolving auth token...");\n  const tokenObj = await resolveAuthToken(browserContext);'
);

patched = patched.replace(
  "    page = await pagePool.getPage(browserContext);",
  '_ts("Getting page from pool...");\n    page = await pagePool.getPage(browserContext);\n    _ts("Page acquired");'
);

patched = patched.replace(
  '    logInfo("Отправка запроса к API v2...");',
  '_ts("Building payload & sending to Qwen API...", `chatId=${chatId}`);' // literal template in target code
);

patched = patched.replace(
  "    const response = await executeApiRequest(",
  '_ts("Waiting for Qwen response... (this may take a while)");\n    const response = await executeApiRequest('
);

if (!patched.includes("_trace0")) {
  console.error("[add-logging] FAILED!");
  // Debug: show if the original string exists
  if (!content.includes(original)) {
    console.log("ERROR: Original string not found in chat.js");
    // Find what's actually there
    const idx = content.indexOf("if (!availableModels)");
    if (idx >= 0) {
      console.log("Found at index", idx);
      console.log("Context:", JSON.stringify(content.substring(idx - 20, idx + 60)));
    }
  }
  process.exit(1);
}

fs.writeFileSync("src/api/chat.js", patched);
console.log("[add-logging] OK — tracing added to sendMessage()");
