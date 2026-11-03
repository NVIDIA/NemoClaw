// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildValidatedCurlCommandArgs } from "../../adapters/http/curl-args";
import { isObjectRecord } from "../../core/json-types";

// True when a `/v1/models` body is an OpenAI-style list: JSON with a `data` array.
export function isOpenAiModelListBody(body: string): boolean {
  try {
    return Array.isArray(JSON.parse(body)?.data);
  } catch {
    return false;
  }
}

// curl output suffix that prints the HTTP status on a final line after the body.
export const MODEL_LIST_STATUS_WRITE_OUT = ["--write-out", "\\n%{http_code}"] as const;

// True when probe output is a model list followed by HTTP status 200. `curl -f`
// still exits 0 for a 3xx, which can carry a model list body.
export function isOpenAiModelListResponse(output: string): boolean {
  const text = output.trimEnd();
  const split = text.lastIndexOf("\n");
  return (
    split >= 0 && text.slice(split + 1) === "200" && isOpenAiModelListBody(text.slice(0, split))
  );
}

// curl argv that probes a `/v1/models` URL and prints the HTTP status after the body.
export function buildModelListProbeCommand(args: string[], url: string): string[] {
  const validated = buildValidatedCurlCommandArgs(["-sf", ...args, url]);
  const target = validated.pop() ?? url;
  return ["curl", ...validated, ...MODEL_LIST_STATUS_WRITE_OUT, target];
}

export function parseModelInventory(provider: string, body: string): string[] | null {
  try {
    const parsed = JSON.parse(body);
    if (!isObjectRecord(parsed)) return null;
    const entries = provider === "ollama-local" ? parsed.models : parsed.data;
    if (!Array.isArray(entries)) return null;
    if (provider !== "ollama-local") {
      return entries.flatMap((entry) => {
        if (!isObjectRecord(entry)) return [];
        return typeof entry.id === "string" && entry.id !== "" ? [entry.id] : [];
      });
    }
    const inventory: string[] = [];
    for (const entry of entries) {
      if (!isObjectRecord(entry)) return null;
      const values = [entry.name, entry.model];
      const names = values.filter(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      if (names.length === 0) return null;
      inventory.push(...names);
    }
    return inventory;
  } catch {
    return null;
  }
}

export function isLocalProviderProbeOutputHealthy(endpoint: string, output: string): boolean {
  const normalized = output.trim();
  if (!normalized || normalized === "000") return false;
  if (endpoint.endsWith("/health")) return normalized === "200";
  return endpoint.endsWith("/models") ? isOpenAiModelListResponse(normalized) : true;
}
