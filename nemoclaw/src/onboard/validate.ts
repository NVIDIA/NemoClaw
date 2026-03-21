// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { observeLatency } from "../observability/metrics.js";

export interface ValidationResult {
  valid: boolean;
  models: string[];
  error: string | null;
}

export async function validateApiKey(
  apiKey: string,
  endpointUrl: string,
): Promise<ValidationResult> {
  try {
    return await observeLatency(
      "tool_api_validate",
      { endpoint: endpointUrl },
      async () => {
        const result = await validateApiKeyInternal(apiKey, endpointUrl);
        if (!result.valid) {
          throw new Error(result.error ?? "Validation failed");
        }
        return result;
      },
    );
  } catch (err) {
    return {
      valid: false,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function validateApiKeyInternal(
  apiKey: string,
  endpointUrl: string,
): Promise<ValidationResult> {
  const url = `${endpointUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 10_000);

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        valid: false,
        models: [],
        error: `HTTP ${String(response.status)}: ${body.slice(0, 200)}`,
      };
    }

    const json = (await response.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id);
    return { valid: true, models, error: null };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Request timed out (10s)"
          : err.message
        : String(err);
    return { valid: false, models: [], error: message };
  } finally {
    clearTimeout(timeout);
  }
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return "****";
  const last4 = apiKey.slice(-4);
  if (apiKey.startsWith("nvapi-")) {
    return `nvapi-****${last4}`;
  }
  return `****${last4}`;
}
