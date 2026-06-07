const f = require("fs");
let c = f.readFileSync("src/api/routes.js", "utf8");

// Fix: Show assistant tool calls as natural language, not raw JSON blob
c = c.replace(
  "parts.push(`Assistant tool calls: ${JSON.stringify(msg.tool_calls)}`);",
  'const actions = msg.tool_calls.map(tc => tc?.function?.name || tc?.name).join(", ");\n        parts.push(`Assistant used tools: ${actions}`);',
);

// Fix: Simpler tool result label
c = c.replace(
  "parts.push(\n        `Tool result (${name}): ${stringifyOpenAIContent(msg.content)}`,\n      );",
  "parts.push(`Tool output (${name}): ${stringifyOpenAIContent(msg.content)}`);",
);

f.writeFileSync("src/api/routes.js", c);
console.log("Fixed transcript folding");
