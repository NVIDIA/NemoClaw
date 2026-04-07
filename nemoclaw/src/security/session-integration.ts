// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Session tracker integration — wires {@link SessionStore} into the
 * OpenClaw plugin lifecycle so that tool calls are automatically
 * classified and recorded as capability events.
 */

import { SessionStore, Capability } from "./session-tracker.js";

// ── Types ────────────────────────────────────────────────────

/** Minimal subset of OpenClawPluginApi needed by the integration. */
export interface PluginApi {
  logger: { warn(message: string): void };
  on(hookName: string, handler: (...args: unknown[]) => void): void;
}

/** Shape of the context object passed to `before_tool_call` handlers. */
interface ToolCallContext {
  sessionId?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

// ── Classification rules ─────────────────────────────────────

const SENSITIVE_PATH_PATTERNS = [
  /\/etc\/(passwd|shadow|sudoers)/,
  /\.env($|\.)/,
  /credentials/i,
  /secret/i,
  /token/i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
];

const READ_TOOLS = new Set(["read_file", "cat", "head", "tail", "str_replace_editor", "view_file"]);

const FETCH_TOOLS = new Set(["fetch", "curl", "wget", "http_get", "browser_navigate", "web_fetch"]);

const EGRESS_TOOLS = new Set([
  "http_post",
  "http_put",
  "send_email",
  "send_message",
  "upload_file",
]);

/**
 * Classify a tool call into a capability class, or return `null` if the
 * tool does not map to any tracked capability.
 *
 * The rules are intentionally conservative — false negatives are
 * acceptable because the tracker is a detection aid, not a policy gate.
 */
/** Extract the first string-typed value from a list of arg keys, or "". */
function stringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string") {
      return v;
    }
  }
  return "";
}

export function classifyToolCall(
  tool: string,
  args: Record<string, unknown>,
): { cap: Capability; detail: string } | null {
  const lowerTool = tool.toLowerCase();

  // Read-sensitive: file-reading tools targeting sensitive paths.
  if (READ_TOOLS.has(lowerTool)) {
    const path = stringArg(args, "path", "file", "filename");
    if (path && SENSITIVE_PATH_PATTERNS.some((re) => re.test(path))) {
      return { cap: Capability.ReadSensitive, detail: path };
    }
    return null;
  }

  // Ingested-untrusted: tools that fetch external content.
  if (FETCH_TOOLS.has(lowerTool)) {
    const url = stringArg(args, "url", "href", "uri");
    return { cap: Capability.IngestedUntrusted, detail: url };
  }

  // Has-egress: tools that send data outbound.
  if (EGRESS_TOOLS.has(lowerTool)) {
    const url = stringArg(args, "url", "to", "destination");
    return { cap: Capability.HasEgress, detail: url };
  }

  return null;
}

// ── Integration entry point ──────────────────────────────────

/**
 * Wire a {@link SessionStore} into the OpenClaw plugin lifecycle.
 *
 * Registers two hooks:
 * - `before_tool_call` — classifies each tool invocation and records
 *   the corresponding capability event.
 * - `session_end` — cleans up the session to prevent unbounded memory
 *   growth in long-running processes.
 *
 * When a trifecta is first detected the plugin logs a warning through
 * the host logger. Callers who need a different response (block, alert,
 * terminate) can instantiate their own {@link SessionStore} with a
 * custom `onTrifecta` callback instead.
 *
 * @returns The {@link SessionStore} instance for programmatic access.
 */
export function wireSessionTracker(api: PluginApi): SessionStore {
  const store = new SessionStore((sessionId) => {
    api.logger.warn(
      `[NemoClaw] trifecta detected for session ${sessionId} — ` +
        "agent has read sensitive data, ingested untrusted input, and attempted egress",
    );
  });

  api.on("before_tool_call", (...hookArgs: unknown[]) => {
    const ctx = (hookArgs[0] ?? {}) as ToolCallContext;
    if (!ctx.sessionId || !ctx.tool) {
      return;
    }
    const result = classifyToolCall(ctx.tool, ctx.args ?? {});
    if (result) {
      store.record(ctx.sessionId, result.cap, ctx.tool, result.detail);
    }
  });

  api.on("session_end", (...hookArgs: unknown[]) => {
    const ctx = (hookArgs[0] ?? {}) as ToolCallContext;
    if (ctx.sessionId) {
      store.delete(ctx.sessionId);
    }
  });

  return store;
}
