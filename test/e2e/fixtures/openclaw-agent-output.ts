// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  openClawAgentIncompleteTurnSignal,
  openClawAgentResponseRecord,
  openClawUnframedJsonText,
  parseOpenClawJsonDocuments,
} from "../../../src/lib/openclaw/agent-json-provenance.ts";
import {
  containsToolCallOutput,
  containsToolCallStructure,
} from "../../helpers/e2e-answer-assertions.ts";

const OPENCLAW_TEXT_KEYS = ["text", "content"] as const;
const OPENCLAW_CONTAINER_KEYS = [
  "result",
  "payloads",
  "payload",
  "messages",
  "choices",
  "message",
  "delta",
  "response",
  "data",
  "output",
  "outputs",
  "items",
  "segments",
] as const;

function responseContainsToolCallStructure(
  document: unknown,
  response: Record<string, unknown>,
): boolean {
  const { meta: _meta, ...replyFields } = response;
  if (containsToolCallStructure(replyFields)) return true;
  if (document === response || !document || typeof document !== "object") return false;
  const { result: _result, ...wrapperFields } = document as Record<string, unknown>;
  return containsToolCallStructure(wrapperFields);
}

function collectOpenClawAssistantText(
  value: unknown,
  parts: string[],
  visited: Set<unknown>,
): void {
  if (value == null || visited.has(value)) return;
  if (typeof value === "string") {
    if (value.trim()) parts.push(value);
    return;
  }
  if (typeof value !== "object") return;
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectOpenClawAssistantText(item, parts, visited));
    return;
  }

  const record = value as Record<string, unknown>;
  const role =
    typeof record.role === "string" ? record.role.replaceAll("_", "-").toLowerCase() : "";
  if (role && role !== "assistant") return;
  for (const key of OPENCLAW_TEXT_KEYS) {
    collectOpenClawAssistantText(record[key], parts, visited);
  }
  for (const key of OPENCLAW_CONTAINER_KEYS) {
    collectOpenClawAssistantText(record[key], parts, visited);
  }
}

function openClawAgentTextParts(raw: string): string[] {
  if (containsToolCallOutput(openClawUnframedJsonText(raw)) || openClawAgentIncompleteTurnSignal(raw)) {
    return [];
  }
  const documents = parseOpenClawJsonDocuments(raw);
  const parts: string[] = [];
  for (const document of documents) {
    const response = openClawAgentResponseRecord(document);
    if (response && Array.isArray(response.payloads)) {
      if (responseContainsToolCallStructure(document, response)) return [];
      collectOpenClawAssistantText(response.payloads, parts, new Set());
    } else if (containsToolCallStructure(document)) {
      return [];
    }
  }
  return parts;
}

export function parseOpenClawAgentText(raw: string): string {
  const reply = openClawAgentTextParts(raw)
    .map((part) => part.trim())
    .join("\n");
  return containsToolCallOutput(reply) ? "" : reply;
}

export function isExactOpenClawAgentText(raw: string, expected: string): boolean {
  const parts = openClawAgentTextParts(raw);
  return parts.length === 1 && parts[0] === expected;
}
