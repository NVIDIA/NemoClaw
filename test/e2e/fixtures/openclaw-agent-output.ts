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

function isOpenClawResponseDocument(value: unknown): value is OpenClawAgentJsonDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["payloads", "result", "response", "choices", "messages", "output", "outputs", "data"].some(
    (key) => Object.hasOwn(record, key),
  );
}

function openClawAgentJsonDocuments(value: unknown): OpenClawAgentJsonDocument[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(isOpenClawResponseDocument);
}

export function parseOpenClawAgentJsonDocuments(raw: string): OpenClawAgentJsonDocument[] {
  return openClawAgentJsonDocuments(parseOpenClawJsonDocuments(raw));
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
  const role = String(record.role).replaceAll("_", "-").toLowerCase();
  if (["user", "tool", "function", "toolresult", "tool-result"].includes(role)) return;
  for (const key of OPENCLAW_TEXT_KEYS) {
    collectOpenClawAssistantText(record[key], parts, visited);
  }
  for (const key of OPENCLAW_CONTAINER_KEYS) {
    collectOpenClawAssistantText(record[key], parts, visited);
  }
}

export function parseOpenClawAgentText(raw: string): string {
  if (containsToolCallOutput(raw)) return "";
  const documents = parseOpenClawAgentJsonDocuments(raw);
  if (documents.some(containsToolCallStructure)) return "";
  const parts: string[] = [];
  for (const document of documents) {
    const response = openClawAgentResponseRecord(document);
    if (response && Array.isArray(response.payloads)) {
      collectOpenClawAssistantText(response.payloads, parts, new Set());
    }
  }
  const reply = parts.join("\n");
  return containsToolCallOutput(reply) ? "" : reply;
}
