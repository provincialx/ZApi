import crypto from "crypto";

export function truncateForPrompt(text, maxLen = 100) {
  if (typeof text !== "string") return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim() + "...";
}

export function compactJsonSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 2) return schema;
  if (Array.isArray(schema))
    return schema.slice(0, 20).map((item) => compactJsonSchema(item, depth + 1));

  const out = {};
  for (const key of ["type", "enum", "required", "default"]) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (schema.description)
    out.description = truncateForPrompt(schema.description, depth === 0 ? 180 : 90);
  if (schema.properties && typeof schema.properties === "object") {
    out.properties = {};
    for (const [name, prop] of Object.entries(schema.properties)) {
      out.properties[name] = compactJsonSchema(prop, depth + 1);
    }
  }
  if (schema.items) out.items = compactJsonSchema(schema.items, depth + 1);
  if (schema.oneOf) out.oneOf = compactJsonSchema(schema.oneOf, depth + 1);
  if (schema.anyOf) out.anyOf = compactJsonSchema(schema.anyOf, depth + 1);
  return out;
}

/**
 * Build Zed tool protocol prompt. Matches Python fork's tools_to_prompt().
 * Sends FULL tool schemas so Qwen knows exact parameter format.
 */
// Shared helper: build compact tool definitions with compressed schemas
function _buildCompactTools(tools) {
  return tools
    .map((tool) => {
      const fn = tool?.function || tool;
      if (!fn?.name) return null;
      const item = { name: fn.name };
      if (fn.description) item.description = truncateForPrompt(fn.description, 120);
      if (fn.parameters && typeof fn.parameters === "object") {
        item.parameters = compactJsonSchema(fn.parameters);
      }
      return item;
    })
    .filter(Boolean);
}

/**
 * Build Zed tool protocol prompt. Matches Python fork's tools_to_prompt().
 * Uses compact schemas to keep context window under control.
 */
export function toolsToPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const compact = _buildCompactTools(tools);
  if (compact.length === 0) return "";

  // Cap total prompt size — prevent context window overflow with many tools.
  let schemaStr = JSON.stringify(compact, null, 0);
  const MAX_SCHEMA_LEN = 6000;
  if (schemaStr.length > MAX_SCHEMA_LEN) {
    // Strip descriptions from all but last few tools to save tokens
    const trimmed = compact.map((t, i) => {
      if (i < compact.length - 5) return { name: t.name, parameters: { type: "object" } };
      return t;
    });
    schemaStr = JSON.stringify(trimmed, null, 0);
  }

  return `You have tools available. To use a tool, output ONLY this exact JSON (no markdown, no backticks, no surrounding text):
{"tool_calls":[{"name":"tool_name","arguments":{"key":"value"}}]}

Example: {"tool_calls":[{"name":"read_file","arguments":{"path":"ZApi/index.js"}}]}

Rules:
- Tool calls are intercepted by the proxy and NEVER shown to the user
- Output EITHER tool_calls JSON OR plain text answer — never both
- All argument values must be double-quoted strings
- After receiving a tool result, do NOT repeat the same call with the same args
- If task is done or no tool is needed, respond with plain text only
- If unsure, ask the user in plain text — do not call tools blindly

Available tools:
${schemaStr}`;
}

// ─── Raw JSON parser helpers (from Python fork) ──────────────────────────────

function _hasToolProtocolKey(obj) {
  if (!obj || typeof obj !== "object") return false;
  const keys = ["tool_calls", "tool_call", "function_call"];
  for (const k of keys) {
    if (k in obj && obj[k] != null) return true;
  }
  // Top-level single call: { name, arguments } without wrapper
  if (obj.name && obj.arguments !== undefined) return false; // handled separately below
  if ("name" in obj && "arguments" in obj && !("content" in obj)) return false;
  return false;
}

function _extractCallsFromParsed(parsed, allowSingle = false) {
  if (!parsed || typeof parsed !== "object") return null;
  let calls = null;
  if (Array.isArray(parsed.tool_calls)) {
    calls = parsed.tool_calls;
  } else if (parsed.function_call || parsed.tool_call) {
    calls = [parsed.function_call || parsed.tool_call];
  } else if (
    allowSingle &&
    parsed.name &&
    parsed.arguments !== undefined &&
    !("content" in parsed)
  ) {
    calls = [parsed];
  }
  return calls;
}

function _repairMalformedJson(text) {
  // Qwen sometimes generates Python-style dicts or other non-JSON artifacts.
  // Try multiple repair passes before giving up.
  let fixed = text;

  // Pass 1: quote unquoted string keys after { or , (must be valid identifier)
  fixed = fixed.replace(/(\{|,)(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1$2"$3":');

  // Pass 2: replace Python None with JSON null
  fixed = fixed.replace(/:\s*(?<!\\)None\b(?=[\s,}\]])/g, ": null");

  // Pass 3: fix single-quoted strings to double-quoted
  fixed = fixed.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');

  return fixed;
}

/**
 * Repair tool call arguments using multiple strategies.
 * Returns the repaired JSON string or original if all repairs fail.
 */
function _repairToolCallArgs(rawJson) {
  // First attempt: standard repair
  try {
    const obj = JSON.parse(rawJson);
    return { value: JSON.stringify(obj, null, 0), repaired: false };
  } catch {}

  const strategies = [
    _repairMalformedJson,

    // Strategy B: add missing closing braces for truncated output
    (t) => {
      let openBraces = 0,
        openBrs = 0;
      for (const c of t) {
        if (c === "{") openBraces++;
        else if (c === "}") openBraces--;
        else if (c === "[") openBrs++;
        else if (c === "]") openBrs--;
      }
      let repaired = t;
      for (let i = 0; i < openBrs; i++) repaired += "]";
      for (let i = 0; i < openBraces; i++) repaired += "}";
      return repaired;
    },

    // Strategy C: repair then balance braces
    (t) => {
      let r = _repairMalformedJson(t);
      let openBraces = 0,
        openBrs = 0;
      for (const c of r) {
        if (c === "{") openBraces++;
        else if (c === "}") openBraces--;
        else if (c === "[") openBrs++;
        else if (c === "]") openBrs--;
      }
      for (let i = 0; i < openBrs; i++) r += "]";
      for (let i = 0; i < openBraces; i++) r += "}";
      return r;
    },
  ];

  for (const strategy of strategies) {
    const repaired = strategy(rawJson);
    try {
      const obj = JSON.parse(repaired);
      console.log(`[TOOL_PARSE] Repaired malformed arguments (${repaired.substring(0, 80)}...)`);
      return { value: JSON.stringify(obj, null, 0), repaired: true };
    } catch {}
  }

  return { value: rawJson, repaired: false };
}

function _normalizeArgs(rawArgs) {
  if (typeof rawArgs === "string") {
    const result = _repairToolCallArgs(rawArgs);
    return result.value;
  }
  if (typeof rawArgs === "object") {
    try {
      return JSON.stringify(rawArgs, null, 0);
    } catch {
      return JSON.stringify({});
    }
  }
  return JSON.stringify({});
}

function _repairTruncatedBraces(text) {
  // Count open/close braces and append missing closing ones.
  let depth = 0;
  const brackets = [];
  for (const ch of text) {
    if (ch === "[") {
      depth++;
      brackets.push("[");
    } else if (ch === "{") {
      depth++;
      brackets.push("{");
    } else if (ch === "]" && brackets.length > 0) {
      const last = brackets.pop();
      if (last !== "[")
        return null; // mismatched
      else depth--;
    } else if (ch === "}" && brackets.length > 0) {
      const last = brackets.pop();
      if (last !== "{")
        return null; // mismatched
      else depth--;
    }
  }
  if (brackets.length === 0) return text || null; // already balanced or empty
  // Append closing braces in reverse order of opening ones
  const needed = [...brackets]
    .reverse()
    .map((b) => (b === "[" ? "]" : "}"))
    .join("");
  return text + needed;
}

/** Strip trailing bracket garbage (]}] etc.) from text that Qwen outputs when aborting JSON. */
function _stripTrailingBracketGarbage(text) {
  // Remove trailing whitespace + unbalanced closing brackets
  const stripped = text.replace(/[\s]*[}\]]+$/, "") || null;
  return stripped?.trim() || null;
}

/**
 * Split Qwen mixed answer into user-visible reasoning text and service tool_calls.
 * Mirrors Python fork's parse_tool_call_parts for Zed Agent compatibility.
 */
export function parseToolCallParts(content) {
  if (typeof content !== "string" || !content.trim()) return { visible: null, calls: null };

  let text = content.trim();

  // Debug trace (silent in production — use lastRawContentForDebug.value for inspection)
  lastRawContentForDebug.value = text.substring(0, 300);

  // Strip full-fence markdown if entire response is fenced JSON
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) {
    text = fence[1].trim();
  }

  // Normalize tool protocol XML artifacts
  text = text.replace(/<\/?(?:function|parameter|tool_call|tool)[^>]*>/gi, "");

  // --- Step 1: Try full parse (complete JSON object / array) ----
  try {
    const parsed = JSON.parse(text);
    const calls = _extractCallsFromParsed(parsed, true);
    if (calls && calls.length > 0) return { visible: "", calls: calls };
  } catch {}

  // --- Step 2: Find the first tool protocol marker and extract balanced JSON ----
  const markerPositions = [
    text.indexOf('"tool_calls"'),
    text.indexOf('"tool_call"'),
    text.indexOf('"function_call"'),
  ].filter((p) => p >= 0);

  if (markerPositions.length > 0) {
    const markerPos = Math.min(...markerPositions);
    // Find the outer wrapper { — search BACKWARD from marker first.
    // The tool_calls key lives INSIDE {"tool_calls":[...]}, so the
    // opening brace is typically BEFORE or AT the marker position.
    let jsonStart = text.lastIndexOf("{", markerPos);
    if (jsonStart < 0) {
      // Fallback: try forward search for nested/odd structures
      jsonStart = text.indexOf("{", markerPos);
    }

    // --- Step 2: Extract tool_calls JSON near marker ----
    let visible;
    let calls;

    if (jsonStart >= 0) {
      // Try balanced extraction from the {
      let depth = 0;
      for (let i = jsonStart; i < text.length; i++) {
        const ch = text[i];
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") depth--;
        if (depth <= 0 && i > jsonStart) {
          try {
            const candidate = text.slice(jsonStart, i + 1);
            const parsed = JSON.parse(candidate);
            calls = _extractCallsFromParsed(parsed);
            if (calls && calls.length > 0) {
              visible = _stripTrailingBracketGarbage(
                text.slice(0, jsonStart - 1).replace(/```(?:json)?\s*```/gi, "")
              );
              return { visible: visible || null, calls };
            }
          } catch {}
        }
      }

      // Repair truncated braces as last resort
      const slice = text.slice(jsonStart);
      const repaired = _repairTruncatedBraces(slice);
      if (repaired) {
        try {
          const parsed = JSON.parse(repaired);
          calls = _extractCallsFromParsed(parsed);
          if (calls && calls.length > 0) {
            visible = _stripTrailingBracketGarbage(
              text.slice(0, jsonStart - 1).replace(/```(?:json)?\s*```/gi, "")
            );
            return { visible: visible || null, calls };
          }
        } catch {}
      }

      // Marker found but JSON unparseable — suppress leak
      visible = _stripTrailingBracketGarbage(
        text.slice(0, jsonStart).replace(/```(?:json)?\s*```/gi, "")
      );
      return { visible: visible || null, calls: [] };
    }
  }

  // --- Step 3: Legacy fallback — find first/last brace ----
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidateSlice = text.slice(firstBrace, lastBrace + 1);

    // Try parse as-is, then with legacy repair patterns
    const attempts = [candidateSlice];
    if (
      /^\s*\{\s*"tool_calls"\s*:\s*\[\s*\{/.test(candidateSlice) &&
      /\}\]\}\s*$/.test(candidateSlice)
    ) {
      attempts.push(candidateSlice.replace(/\}\]\}\s*$/, "}}]}"));
    }
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[/.test(candidateSlice) && !/\}\s*$/.test(candidateSlice)) {
      attempts.push(candidateSlice + "}");
    }

    for (const attempt of attempts) {
      try {
        const parsed = JSON.parse(attempt);
        const calls = _extractCallsFromParsed(parsed, true);
        if (calls && calls.length > 0) {
          return { visible: text.slice(0, firstBrace).trim() || null, calls };
        }
      } catch {}
    }
  }

  // No tool_calls found — return full text as visible, stripped of trailing bracket garbage.
  // Qwen sometimes aborts mid-JSON generation and leaves trailing ]} artifacts that leak to Zed.
  let visible = _stripTrailingBracketGarbage(content.trim());
  return { visible: visible || null, calls: null };
}

// ─── Debug state ────────────────────────────────────────────────────────────

export const lastRawContentForDebug = { value: null };

/** @deprecated use parseToolCallParts and read .calls instead */
export function parseToolCallJson(content) {
  const parts = parseToolCallParts(content);
  if (!parts.calls || parts.calls.length === 0) return null;

  // Normalize arguments through JSON.parse/stringify to guarantee balanced minified output
  return normalizeToolCalls(parts.calls);
}

/** Take raw call objects and normalize into OpenAI-compatible format */
export function normalizeToolCalls(calls) {
  return calls
    .map((call, index) => {
      const name = call.name || call.tool || call.function?.name;
      const rawArgs = call.arguments ?? call.args ?? call.input ?? call.function?.arguments ?? {};
      const args = _normalizeArgs(rawArgs);
      if (!name) return null;
      return {
        id: call.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: { name, arguments: args },
        index,
      };
    })
    .filter(Boolean);
}

export function applyToolPrompt(systemMessage, tools, inAgentLoop = false) {
  if (!Array.isArray(tools) || tools.length === 0) return systemMessage;

  let prompt;
  if (inAgentLoop) {
    // Light mode: model already has tool results. Don't coerce into more tool calls.
    // Just remind it can parse tool JSON if needed, but prefer natural language answer.
    prompt = toolsToLightPrompt(tools);
  } else {
    prompt = toolsToPrompt(tools);
  }

  return prompt ? `${systemMessage || ""}${prompt}`.trim() : systemMessage;
}

/** Agent-loop prompt: model has tool results.
 * Light version — don't coerce into more tool calls, but keep anti-loop guard.
 * Uses compact schemas to fit context window. */
export function toolsToLightPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const compact = _buildCompactTools(tools);

  // Cap schema size — same limit as full prompt to prevent context overflow
  let schemaStr = JSON.stringify(compact, null, 0);
  const MAX_SCHEMA_LEN = 6000;
  if (schemaStr.length > MAX_SCHEMA_LEN) {
    schemaStr = JSON.stringify(
      compact.map((t, i) =>
        i < compact.length - 5 ? { name: t.name, parameters: { type: "object" } } : t
      ),
      null,
      0
    );
  }

  return `=== TOOL USAGE RULES ===
You are in AGENT LOOP with tools. Your task is to EXECUTE actions, not explain them:
- Received error from a tool? ANALYZE the error → CALL another tool with CORRECTED arguments OR give final answer
- NEVER output "Терминал недоступен" or similar errors as your own message — those are TOOL results, call next step
- AFTER receiving a tool result, DO NOT repeat the SAME tool call with the SAME arguments
- If Status: Completed — consider the result received even if output is empty
- Task COMPLETE → Write plain text answer with findings WITHOUT any JSON
- NEVER output your intention to call a tool as visible text
- Either output ONLY the tool_calls JSON OR ONLY plain text answer. Never both.

If the request is unclear or you don't understand what exactly needs to be done — DO NOT call a tool blindly, ask the user for clarification in plain text instead.

When you NEED to call another tool, output ONLY this minified JSON (no surrounding text, no markdown):
{"tool_calls":[{"name":"","arguments":{}}]}
Available Zed tools:
${schemaStr}`;
}
