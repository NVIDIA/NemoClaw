// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CurlProbeResult } from "./http-probe";
import { getCurlTimingArgs, runCurlProbe } from "./http-probe";
import type { ModelCatalogFetchResult, ModelValidationResult } from "./onboard-types";

// credentials.ts still uses CommonJS-style exports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeCredentialValue } = require("./credentials");

export const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";

export interface ProviderModelOptions {
  runCurlProbeImpl?: (argv: string[]) => CurlProbeResult;
  buildEndpointUrl?: string;
  /** When "query-param", send the API key as a ?key= URL parameter instead of
   *  an Authorization: Bearer header. Required for Google Gemini which rejects
   *  requests carrying both auth methods. See issue #1960. */
  authMode?: "bearer" | "query-param";
}

function parseModelIds(body: string, itemKeys: string[] = ["id"]): string[] {
  const parsed = JSON.parse(body) as { data?: Array<Record<string, unknown> | null> };
  if (!Array.isArray(parsed?.data)) {
    throw new Error("Unexpected model catalog response: expected a top-level data array");
  }
  return parsed.data
    .map((item) => {
      if (!item) return null;
      for (const key of itemKeys) {
        const value = item[key];
        if (typeof value === "string" && value) {
          return value;
        }
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function toModelCatalogFetchResult(
  result: CurlProbeResult,
  itemKeys: string[] = ["id"],
): ModelCatalogFetchResult {
  if (!result.ok) {
    return {
      ok: false,
      message: result.message,
      httpStatus: result.httpStatus,
      curlStatus: result.curlStatus,
    };
  }

  try {
    return { ok: true, ids: parseModelIds(result.body, itemKeys) };
  } catch (error) {
    return {
      ok: false,
      httpStatus: result.httpStatus,
      curlStatus: result.curlStatus,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function fetchNvidiaEndpointModels(
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelCatalogFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const buildEndpointUrl = options.buildEndpointUrl ?? BUILD_ENDPOINT_URL;
  try {
    const result = runCurlProbeImpl([
      "-sS",
      ...getCurlTimingArgs(),
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${normalizeCredentialValue(apiKey)}`,
      `${buildEndpointUrl}/models`,
    ]);
    return toModelCatalogFetchResult(result);
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateNvidiaEndpointModel(
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelValidationResult {
  const buildEndpointUrl = options.buildEndpointUrl ?? BUILD_ENDPOINT_URL;
  const available = fetchNvidiaEndpointModels(apiKey, options);
  if (!available.ok) {
    return {
      ok: false,
      httpStatus: available.httpStatus,
      curlStatus: available.curlStatus,
      message: `Could not validate model against ${buildEndpointUrl}/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    httpStatus: 200,
    curlStatus: 0,
    message: `Model '${model}' is not available from NVIDIA Endpoints. Checked ${buildEndpointUrl}/models.`,
  };
}

export function fetchOpenAiLikeModels(
  endpointUrl: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelCatalogFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const useQueryParam = options.authMode === "query-param";
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  const baseUrl = `${String(endpointUrl).replace(/\/+$/, "")}/models`;
  const url = useQueryParam && normalizedKey ? `${baseUrl}?key=${encodeURIComponent(normalizedKey)}` : baseUrl;
  try {
    const result = runCurlProbeImpl([
      "-sS",
      ...getCurlTimingArgs(),
      ...(!useQueryParam && normalizedKey ? ["-H", `Authorization: Bearer ${normalizedKey}`] : []),
      url,
    ]);
    return toModelCatalogFetchResult(result);
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function fetchAnthropicModels(
  endpointUrl: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelCatalogFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  try {
    const result = runCurlProbeImpl([
      "-sS",
      ...getCurlTimingArgs(),
      "-H",
      `x-api-key: ${normalizeCredentialValue(apiKey)}`,
      "-H",
      "anthropic-version: 2023-06-01",
      `${String(endpointUrl).replace(/\/+$/, "")}/v1/models`,
    ]);
    return toModelCatalogFetchResult(result, ["id", "name"]);
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateAnthropicModel(
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelValidationResult {
  const normalizedEndpointUrl = String(endpointUrl).replace(/\/+$/, "");
  const available = fetchAnthropicModels(endpointUrl, apiKey, options);
  if (!available.ok) {
    if (available.httpStatus === 404 || available.httpStatus === 405) {
      return { ok: true, validated: false };
    }
    return {
      ok: false,
      httpStatus: available.httpStatus,
      curlStatus: available.curlStatus,
      message: `Could not validate model against ${normalizedEndpointUrl}/v1/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    httpStatus: 200,
    curlStatus: 0,
    message: `Model '${model}' is not available from Anthropic. Checked ${normalizedEndpointUrl}/v1/models.`,
  };
}

export function validateOpenAiLikeModel(
  label: string,
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelValidationResult {
  const normalizedEndpointUrl = String(endpointUrl).replace(/\/+$/, "");
  const available = fetchOpenAiLikeModels(endpointUrl, apiKey, options);
  if (!available.ok) {
    if (available.httpStatus === 404 || available.httpStatus === 405) {
      return { ok: true, validated: false };
    }
    return {
      ok: false,
      httpStatus: available.httpStatus,
      curlStatus: available.curlStatus,
      message: `Could not validate model against ${normalizedEndpointUrl}/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    httpStatus: 200,
    curlStatus: 0,
    message: `Model '${model}' is not available from ${label}. Checked ${normalizedEndpointUrl}/models.`,
  };
}
