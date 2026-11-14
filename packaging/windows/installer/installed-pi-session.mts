// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import path from "node:path";

type Row = Record<string, unknown>;
function object(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}
function messageText(content: unknown, assistant = false): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const value of content) {
    const part = object(value);
    // Pi 0.84.1 stores reasoning separately from answer text. It may accompany
    // a final answer but cannot itself satisfy the expected reply.
    if (assistant && part?.type === "thinking" && typeof part.thinking === "string") continue;
    if (part?.type !== "text" || typeof part.text !== "string") return null;
    parts.push(part.text);
  }
  return parts.join("");
}

// Observe the pinned Pi v3 session format without executing or importing its code.
// A screen echo alone cannot establish a model reply. Return only proof identity,
// never saved conversation content (which may contain credentials or user data).
export function recordedPiReply(
  text: string,
  expected: {
    prompt: string;
    reply: string;
    model: string;
    cwd: string;
    startedAt: number;
    sessionId?: string;
    file?: { path: string; content: string };
  },
) {
  assert.match(expected.reply, /^PI_REPLY_[a-f0-9]{20}$/u);
  assert(Number.isFinite(expected.startedAt));
  assert(text.length <= 1024 * 1024, "Pi session evidence exceeded its bound");
  // Pi appends JSONL records. An unfinished last line is not evidence yet.
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  if (!complete) return null;
  const lines = complete.trimEnd().split("\n");
  assert(lines.length <= 4096, "Pi session record count exceeded its bound");
  const entries = lines.map((line) => {
    assert(line.length <= 128 * 1024, "Pi session record exceeded its bound");
    try {
      const entry = object(JSON.parse(line));
      assert(entry !== null);
      return entry;
    } catch {
      // Do not include the malformed record in the error.
      throw new Error("Pi session contains an invalid complete record");
    }
  });
  const header = entries[0];
  assert(header.type === "session" && header.version === 3, "Unexpected Pi session format");
  assert(
    typeof header.id === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(header.id),
    "Invalid Pi session identity",
  );
  assert(header.cwd === expected.cwd, "Pi session belongs to another working directory");
  const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
  assert(
    Number.isFinite(created) && created >= expected.startedAt,
    "Pi session predates this launch",
  );
  if (expected.sessionId !== undefined)
    assert(header.id === expected.sessionId, "Pi changed sessions during the conversation");

  const seen = new Set<string>();
  let previous: string | null = null;
  let user: Row | null = null;
  let assistant: Row | null = null;
  let turn: Row[] = [];
  for (const entry of entries.slice(1)) {
    assert(typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 64);
    assert(!seen.has(entry.id), "Duplicate Pi session entry");
    seen.add(entry.id);
    // Acceptance starts a new, unbranched conversation. Do not pair unrelated
    // branches, compacted history, or a later user turn with the requested turn.
    assert(entry.parentId === previous, "Pi acceptance conversation is not linear");
    previous = entry.id;
    if (entry.type !== "message") {
      if (user) return null;
      continue;
    }
    const message = object(entry.message);
    assert(message !== null, "Invalid Pi message");
    if (message.role === "user") {
      user = messageText(message.content) === expected.prompt ? entry : null;
      assistant = null;
      turn = [];
    } else if (message.role === "assistant") {
      assistant = user !== null ? entry : null;
      if (user) turn.push(message);
    } else {
      assistant = null;
      if (user) turn.push(message);
    }
  }
  if (!user || !assistant) return null;
  const message = object(assistant.message)!;
  if (
    (!expected.file && assistant.parentId !== user.id) ||
    message.provider !== "openshell" ||
    message.model !== expected.model ||
    message.stopReason !== "stop" ||
    message.errorMessage != null ||
    messageText(message.content, true)?.trim() !== expected.reply
  )
    return null;
  if (expected.file) {
    assert.match(expected.file.path, /^qualification-[a-f0-9]{20}\.txt$/u);
    // Pi's pinned write/read tools execute sequentially. A final textual claim,
    // an unfinished call, or a result for a different call is not file evidence.
    if (turn.length !== 5) return null;
    const callIds = new Set<string>();
    for (const [index, name] of ["write", "read"].entries()) {
      const request = turn[index * 2],
        result = turn[index * 2 + 1];
      if (
        request.role !== "assistant" ||
        request.provider !== "openshell" ||
        request.model !== expected.model ||
        request.stopReason !== "toolUse" ||
        request.errorMessage != null ||
        !Array.isArray(request.content)
      )
        return null;
      const calls = request.content.map(object).filter((part) => part?.type === "toolCall");
      if (
        calls.length !== 1 ||
        messageText(
          request.content.filter((part) => object(part)?.type !== "toolCall"),
          true,
        ) === null
      )
        return null;
      const call = calls[0]!,
        args = object(call.arguments);
      if (
        call.name !== name ||
        typeof call.id !== "string" ||
        !call.id ||
        call.id.length > 256 ||
        callIds.has(call.id) ||
        !args ||
        typeof args.path !== "string" ||
        path.win32.resolve(expected.cwd, args.path).toLowerCase() !==
          path.win32.resolve(expected.cwd, expected.file.path).toLowerCase()
      )
        return null;
      callIds.add(call.id);
      if (
        index === 0
          ? args.content !== expected.file.content
          : (args.offset !== undefined && args.offset !== 1) || args.limit !== undefined
      )
        return null;
      if (
        result.role !== "toolResult" ||
        result.toolCallId !== call.id ||
        result.toolName !== name ||
        result.isError !== false
      )
        return null;
      const output = messageText(result.content);
      if (
        index === 0
          ? output !== `Successfully wrote ${expected.file.content.length} bytes to ${args.path}`
          : output !== expected.file.content
      )
        return null;
    }
  }
  return {
    sessionId: header.id,
    userEntryId: user.id,
    assistantEntryId: assistant.id,
    ...(expected.file ? { fileTools: true } : {}),
  };
}
