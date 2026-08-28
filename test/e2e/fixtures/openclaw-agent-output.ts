// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

interface OpenClawAgentJsonDocument {
  payloads?: Array<{ text?: unknown }>;
  result?: { payloads?: Array<{ text?: unknown }> };
}

function parseOpenClawAgentJsonDocuments(raw: string): OpenClawAgentJsonDocument[] {
  try {
    const parsed = JSON.parse(raw) as OpenClawAgentJsonDocument | OpenClawAgentJsonDocument[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // OpenClaw has emitted both complete JSON documents and log-prefixed
    // streams. Keep this compatibility parser local to the E2E fixture layer.
  }

  const documents: OpenClawAgentJsonDocument[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "{") continue;
    for (let end = index + 1; end <= raw.length; end += 1) {
      try {
        const parsed = JSON.parse(raw.slice(index, end)) as
          | OpenClawAgentJsonDocument
          | OpenClawAgentJsonDocument[];
        documents.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        index = end - 1;
        break;
      } catch {
        // Keep extending the candidate slice until it becomes valid JSON.
      }
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
