// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  openClawAgentResponseRecord,
  parseOpenClawJsonDocuments,
} from "../../../src/lib/openclaw/agent-json-provenance.ts";
import {
  containsToolCallOutput,
  containsToolCallStructure,
} from "../../helpers/e2e-answer-assertions.ts";

export interface OpenClawAgentJsonDocument {
  [key: string]: unknown;
  payloads?: Array<{ text?: unknown }>;
  result?: { meta?: unknown; payloads?: Array<{ text?: unknown }> };
}

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

export function parseOpenClawAgentJsonDocuments(raw: string): OpenClawAgentJsonDocument[] {
  return parseOpenClawJsonDocuments(raw).filter(
    (document): document is OpenClawAgentJsonDocument => openClawAgentResponseRecord(document) !== null,
  );
}

function collectOpenClawAssistantText(
  value: unknown,
  parts: string[],
  visited: Set<unknown>,
): void {
  if (value == null || visited.has(value)) return;
  if (typeof value === "string") {
    if (value.trim()) parts.push(value.trim());
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

export function parseOpenClawAgentText(raw: string): string {
  if (containsToolCallOutput(raw)) return "";
  const document = parseOpenClawAgentJsonDocuments(raw).at(-1);
  if (!document || containsToolCallStructure(document)) return "";
  const response = openClawAgentResponseRecord(document);
  if (!response || containsToolCallStructure(response)) return "";
  const parts: string[] = [];
  collectOpenClawAssistantText(response.payloads, parts, new Set());
  const reply = parts.join("\n");
  return containsToolCallOutput(reply) ? "" : reply;
}
