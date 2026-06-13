// services/qwen/api/fileCache.js
// In-memory cache for file reads and directory listings.
// Prevents Qwen from re-reading the same files in agent loops.
// Populated from tool results passing through the proxy.

const fileCache = new Map();
const dirCache = new Map();
const CACHE_TTL_MS = 120_000; // 2 minutes —足夠 для long agent-loop

import { logDebug } from "../../../shared/logger/index.js";

/**
 * Get cached file content by absolute/project path.
 */
export function getCachedFile(path) {
  const entry = fileCache.get(path);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    fileCache.delete(path);
    return null;
  }
  return entry.content;
}

/**
 * Store file content in cache.
 */
export function setCachedFile(path, content) {
  if (!path || content === undefined || content === null) return;
  fileCache.set(path, { content, timestamp: Date.now() });
  logDebug(`[FileCache] cached: ${path} (${String(content).length} chars)`);
  // GC stale entries when map grows large
  if (fileCache.size > 1000) gc(fileCache);
}

/**
 * Get cached directory listing by path.
 */
export function getCachedDir(path) {
  const entry = dirCache.get(path);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    dirCache.delete(path);
    return null;
  }
  return entry.content;
}

/**
 * Store directory listing in cache.
 */
export function setCachedDir(path, content) {
  if (!path || content === undefined || content === null) return;
  dirCache.set(path, { content, timestamp: Date.now() });
  logDebug(`[FileCache] cached dir: ${path} (${String(content).length} chars)`);
  if (dirCache.size > 500) gc(dirCache);
}

/**
 * Scan tool calls from a parsed Qwen response.
 * Returns array of { toolCall, cachedResult } for cached tools,
 * or null if no cache hit.
 */
export function getCachedToolResults(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

  const hits = [];
  for (const tc of toolCalls) {
    const name = tc.name || tc.function?.name;
    const rawArgs = tc.arguments || tc.function?.arguments || {};
    const args = typeof rawArgs === "string" ? tryParseJson(rawArgs) : rawArgs;

    if (name === "read_file" && args?.path) {
      const cached = getCachedFile(String(args.path));
      if (cached !== null) {
        hits.push({ toolCall: tc, name, path: args.path, content: cached });
      }
    } else if (name === "list_directory" && args?.path) {
      const cached = getCachedDir(String(args.path));
      if (cached !== null) {
        hits.push({ toolCall: tc, name, path: args.path, content: cached });
      }
    }
  }
  return hits.length > 0 ? hits : null;
}

/**
 * Scan incoming messages for tool results to populate cache.
 * Call this on each request before sending to Qwen.
 */
export function populateCacheFromMessages(messages) {
  if (!Array.isArray(messages)) return;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool" || !msg.content) continue;

    // Find the preceding assistant message with tool_calls to match name+args
    const toolCallId = msg.tool_call_id;
    if (!toolCallId) continue;

    // Walk backwards to find the assistant message that issued this tool_call
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j];
      if (prev.role !== "assistant" || !prev.tool_calls) continue;

      for (const tc of prev.tool_calls) {
        if (tc.id === toolCallId || tc.index !== undefined) {
          const name = tc.function?.name || tc.name;
          const rawArgs = tc.function?.arguments || tc.arguments || {};
          const args = typeof rawArgs === "string" ? tryParseJson(rawArgs) : rawArgs;

          if (name === "read_file" && args?.path) {
            setCachedFile(String(args.path), String(msg.content));
          } else if (name === "list_directory" && args?.path) {
            setCachedDir(String(args.path), String(msg.content));
          }
          break;
        }
      }
      break; // Only check the immediate preceding assistant message
    }
  }
}

/**
 * Build updated messages array with simulated tool results for cached calls.
 * Returns { messages, toolCallIds } or null if no cache hits.
 * The caller should append these and recurse to Qwen.
 */
export function buildCachedToolResultMessages(messages, cachedHits) {
  if (!cachedHits || cachedHits.length === 0) return null;

  const newMessages = [...messages];
  const now = Date.now();

  for (const hit of cachedHits) {
    const toolCallId = hit.toolCall.id || `cached_${now}_${Math.random().toString(36).slice(2, 6)}`;

    // Normalize tool call to OpenAI format for the assistant message
    const tcName = hit.toolCall.name || hit.toolCall.function?.name || hit.name;
    const tcRawArgs = hit.toolCall.arguments || hit.toolCall.function?.arguments || {};
    const tcArgsStr = typeof tcRawArgs === "string" ? tcRawArgs : JSON.stringify(tcRawArgs);

    newMessages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: toolCallId,
          type: "function",
          function: { name: tcName, arguments: tcArgsStr },
        },
      ],
    });

    newMessages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: String(hit.content),
    });
  }

  return newMessages;
}

/**
 * Check if cached tool calls already have results in the message history.
 * Returns true if ALL cached calls already have results, false otherwise.
 * Used to avoid re-injecting results that are already in the conversation.
 */
export function cachedCallsAlreadyHaveResults(messages, cachedHits) {
  if (!cachedHits || cachedHits.length === 0) return false;

  // Find the last assistant message with tool_calls
  let lastAssistIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant" && messages[i]?.tool_calls?.length > 0) {
      lastAssistIdx = i;
      break;
    }
  }
  if (lastAssistIdx < 0) return false;

  // Check for tool results after the assistant message
  const toolSigs = new Set();
  for (let i = lastAssistIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool" && m.tool_call_id) {
      // Match by finding the function name from assistant tool_calls
      for (const tc of messages[lastAssistIdx].tool_calls || []) {
        if (tc.id === m.tool_call_id) {
          const name = tc.function?.name || tc.name;
          const rawArgs = tc.function?.arguments || tc.arguments || {};
          const args = typeof rawArgs === "string" ? tryParseJson(rawArgs) : rawArgs;
          if (name && args?.path) {
            toolSigs.add(`${name}:${args.path}`);
          }
          break;
        }
      }
    }
  }

  // Check if all cached hits are already in results
  for (const hit of cachedHits) {
    if (!toolSigs.has(`${hit.name}:${hit.path}`)) return false;
  }
  return true;
}

function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function gc(map) {
  const now = Date.now();
  for (const [key, val] of map) {
    if (now - val.timestamp > CACHE_TTL_MS) map.delete(key);
  }
}
