// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface OpenClawAgentJsonDocument {
  payloads?: Array<{ text?: unknown }>;
  result?: { meta?: unknown; payloads?: Array<{ text?: unknown }> };
}

function openClawAgentJsonDocuments(value: unknown): OpenClawAgentJsonDocument[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(
    (entry): entry is OpenClawAgentJsonDocument =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

export function parseOpenClawAgentJsonDocuments(raw: string): OpenClawAgentJsonDocument[] {
  try {
    return openClawAgentJsonDocuments(JSON.parse(raw) as unknown);
  } catch {
    // OpenClaw has emitted both complete JSON documents and log-prefixed
    // streams. Keep this compatibility parser local to the E2E fixture layer.
  }

  const documents: OpenClawAgentJsonDocument[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    if (depth !== 0) continue;

    try {
      documents.push(
        ...openClawAgentJsonDocuments(JSON.parse(raw.slice(start, index + 1)) as unknown),
      );
    } catch {
      // A balanced log fragment is not necessarily JSON. Resume scanning at
      // the next top-level object instead of retrying every candidate suffix.
    } finally {
      start = -1;
      inString = false;
      escaped = false;
    }
  }
  return documents;
}

export function parseOpenClawAgentText(raw: string): string {
  return parseOpenClawAgentJsonDocuments(raw)
    .flatMap((document) => document.payloads ?? document.result?.payloads ?? [])
    .map((payload) => payload.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
}
