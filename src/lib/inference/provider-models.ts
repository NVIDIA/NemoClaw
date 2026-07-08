// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CurlAuthConfig,
  createBearerAuthConfig,
  createOpenAiLikeAuthConfig,
  createXApiKeyAuthConfig,
  type OpenAiLikeAuthMode,
} from "../adapters/http/auth-config";
import type { CurlProbeOptions, CurlProbeResult } from "../adapters/http/probe";
import { getCurlTimingArgs, runCurlProbe } from "../adapters/http/probe";
import type { ModelCatalogFetchResult, ModelValidationResult } from "../onboard/types";

// credentials.ts still uses CommonJS-style exports.
const { normalizeCredentialValue } = require("../credentials/store");

export const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";

export interface ProviderModelOptions {
  runCurlProbeImpl?: (argv: string[], opts?: CurlProbeOptions) => CurlProbeResult;
  buildEndpointUrl?: string;
  /** When "query-param", send the API key as a ?key= URL parameter instead of
   *  an Authorization: Bearer header. Required for Google Gemini which rejects
   *  requests carrying both auth methods. See issue #1960. */
  authMode?: OpenAiLikeAuthMode;
}

function buildOpenAiLikeAuthConfig(apiKey: string, options: ProviderModelOptions): CurlAuthConfig {
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  return createOpenAiLikeAuthConfig(normalizedKey, options.authMode);
}

function fetchResultFromError(error: unknown): ModelCatalogFetchResult {
  return {
    ok: false,
    httpStatus: 0,
    curlStatus: 0,
    message: error instanceof Error ? error.message : String(error),
  };
}

type ModelCatalogItem = {
  id?: string | null;
  name?: string | null;
};

type ModelCatalogResponse = {
  data?: Array<ModelCatalogItem | null>;
};

/**
 * Parses a provider catalog response body as JSON.
 */
function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

/**
 * Extracts safe string model IDs from an OpenAI-compatible catalog response.
 */
function parseModelIds(body: string, itemKeys: Array<keyof ModelCatalogItem> = ["id"]): string[] {
  const parsed = parseJson<ModelCatalogResponse>(body);
  if (!Array.isArray(parsed.data)) {
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

/**
 * Converts a curl probe result into NemoClaw's model catalog result shape.
 */
function toModelCatalogFetchResult(
  result: CurlProbeResult,
  itemKeys: Array<keyof ModelCatalogItem> = ["id"],
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

/**
 * Fetches available NVIDIA Endpoint model IDs using the provided API key.
 */
export function fetchNvidiaEndpointModels(
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelCatalogFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const buildEndpointUrl = options.buildEndpointUrl ?? BUILD_ENDPOINT_URL;
  let authConfig: CurlAuthConfig | undefined;
  try {
    authConfig = createBearerAuthConfig(normalizeCredentialValue(apiKey));
    const result = runCurlProbeImpl(
      [
        "-sS",
        ...getCurlTimingArgs(),
        "-H",
        "Content-Type: application/json",
        ...authConfig.args,
        `${buildEndpointUrl}/models`,
      ],
      { trustedConfigFiles: authConfig.trustedConfigFiles },
    );
    return toModelCatalogFetchResult(result);
  } catch (error) {
    return fetchResultFromError(error);
  } finally {
    authConfig?.cleanup();
  }
}

/**
 * Validates that a selected model appears in the NVIDIA Endpoints catalog.
 */
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

/**
 * Fetches model IDs from an OpenAI-compatible `/models` endpoint.
 */
export function fetchOpenAiLikeModels(
  endpointUrl: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelCatalogFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const baseUrl = `${String(endpointUrl).replace(/\/+$/, "")}/models`;
  let authConfig: CurlAuthConfig | undefined;
  try {
    authConfig = buildOpenAiLikeAuthConfig(apiKey, options);
    const result = runCurlProbeImpl(["-sS", ...getCurlTimingArgs(), ...authConfig.args, baseUrl], {
      trustedConfigFiles: authConfig.trustedConfigFiles,
    });
    return toModelCatalogFetchResult(result);
  } catch (error) {
    return fetchResultFromError(error);
  } finally {
    authConfig?.cleanup();
  }
}

/**
 * Fetches Anthropic-compatible model IDs from a Messages API provider.
 */
export function fetchAnthropicModels(
  endpointUrl: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelCatalogFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  let authConfig: CurlAuthConfig | undefined;
  try {
    authConfig = createXApiKeyAuthConfig(normalizeCredentialValue(apiKey));
    const result = runCurlProbeImpl(
      [
        "-sS",
        ...getCurlTimingArgs(),
        ...authConfig.args,
        "-H",
        "anthropic-version: 2023-06-01",
        `${String(endpointUrl).replace(/\/+$/, "")}/v1/models`,
      ],
      { trustedConfigFiles: authConfig.trustedConfigFiles },
    );
    return toModelCatalogFetchResult(result, ["id", "name"]);
  } catch (error) {
    return fetchResultFromError(error);
  } finally {
    authConfig?.cleanup();
  }
}

/**
 * Validates a selected model against an Anthropic-compatible provider catalog.
 */
export function validateAnthropicModel(
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelValidationResult {
  const normalizedEndpointUrl = String(endpointUrl).replace(/\/+$/, "");
  const available = fetchAnthropicModels(normalizedEndpointUrl, apiKey, options);
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

/**
 * Validates a selected model against an OpenAI-compatible provider catalog.
 */
export function validateOpenAiLikeModel(
  label: string,
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelValidationResult {
  const normalizedEndpointUrl = String(endpointUrl).replace(/\/+$/, "");
  const available = fetchOpenAiLikeModels(normalizedEndpointUrl, apiKey, options);
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
