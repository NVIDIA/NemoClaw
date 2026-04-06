// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCurlTimingArgs, runCurlProbe, type CurlProbeResult } from "./http-probe";

// credentials.js is CJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeCredentialValue } = require("../../bin/lib/credentials");

export const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";

export interface FetchModelsSuccess {
  ok: true;
  ids: string[];
}

export interface FetchModelsFailure {
  ok: false;
  message: string;
  status?: number;
  curlStatus?: number;
}

export type FetchModelsResult = FetchModelsSuccess | FetchModelsFailure;

export interface ValidateModelResult {
  ok: boolean;
  message?: string;
  validated?: boolean;
}

export interface ProviderModelOptions {
  runCurlProbeImpl?: (argv: string[]) => CurlProbeResult;
  buildEndpointUrl?: string;
}

function parseModelIds(body: string, itemKeys: string[] = ["id"]): string[] {
  const parsed = JSON.parse(body) as { data?: Array<Record<string, unknown> | null> };
  if (!Array.isArray(parsed?.data)) return [];
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

export function fetchNvidiaEndpointModels(
  apiKey: string,
  options: ProviderModelOptions = {},
): FetchModelsResult {
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
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        status: result.httpStatus,
        curlStatus: result.curlStatus,
      };
    }
    return { ok: true, ids: parseModelIds(result.body) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      curlStatus: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateNvidiaEndpointModel(
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ValidateModelResult {
  const buildEndpointUrl = options.buildEndpointUrl ?? BUILD_ENDPOINT_URL;
  const available = fetchNvidiaEndpointModels(apiKey, options);
  if (!available.ok) {
    return {
      ok: false,
      message: `Could not validate model against ${buildEndpointUrl}/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `Model '${model}' is not available from NVIDIA Endpoints. Checked ${buildEndpointUrl}/models.`,
  };
}

export function fetchOpenAiLikeModels(
  endpointUrl: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): FetchModelsResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  try {
    const result = runCurlProbeImpl([
      "-sS",
      ...getCurlTimingArgs(),
      ...(apiKey ? ["-H", `Authorization: Bearer ${normalizeCredentialValue(apiKey)}`] : []),
      `${String(endpointUrl).replace(/\/+$/, "")}/models`,
    ]);
    if (!result.ok) {
      return {
        ok: false,
        status: result.httpStatus,
        curlStatus: result.curlStatus,
        message: result.message,
      };
    }
    return { ok: true, ids: parseModelIds(result.body) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function fetchAnthropicModels(
  endpointUrl: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): FetchModelsResult {
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
    if (!result.ok) {
      return {
        ok: false,
        status: result.httpStatus,
        curlStatus: result.curlStatus,
        message: result.message,
      };
    }
    return { ok: true, ids: parseModelIds(result.body, ["id", "name"]) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateAnthropicModel(
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ValidateModelResult {
  const normalizedEndpointUrl = String(endpointUrl).replace(/\/+$/, "");
  const available = fetchAnthropicModels(endpointUrl, apiKey, options);
  if (!available.ok) {
    if (available.status === 404 || available.status === 405) {
      return { ok: true, validated: false };
    }
    return {
      ok: false,
      message: `Could not validate model against ${normalizedEndpointUrl}/v1/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    message: `Model '${model}' is not available from Anthropic. Checked ${normalizedEndpointUrl}/v1/models.`,
  };
}

export function validateOpenAiLikeModel(
  label: string,
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ValidateModelResult {
  const normalizedEndpointUrl = String(endpointUrl).replace(/\/+$/, "");
  const available = fetchOpenAiLikeModels(endpointUrl, apiKey, options);
  if (!available.ok) {
    if (available.status === 404 || available.status === 405) {
      return { ok: true, validated: false };
    }
    return {
      ok: false,
      message: `Could not validate model against ${normalizedEndpointUrl}/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    message: `Model '${model}' is not available from ${label}. Checked ${normalizedEndpointUrl}/models.`,
  };
}
