// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CurlAuthConfig,
  createBearerAuthConfig,
  createCurlAuthConfig,
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
export const GEMINI_NATIVE_MODELS_ENDPOINT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_MODEL_CATALOG_MAX_PAGES = 25;

export interface ProviderModelOptions {
  runCurlProbeImpl?: (argv: string[], opts?: CurlProbeOptions) => CurlProbeResult;
  buildEndpointUrl?: string;
  extraHeaders?: readonly string[];
  /** When "query-param", send the API key as a ?key= URL parameter instead of
   *  an Authorization: Bearer header. */
  authMode?: OpenAiLikeAuthMode;
}

function buildOpenAiLikeAuthConfig(apiKey: string, options: ProviderModelOptions): CurlAuthConfig {
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  return createOpenAiLikeAuthConfig(normalizedKey, options.authMode, {
    extraHeaders: options.extraHeaders,
  });
}

/**
 * Detects Google's Gemini host even when the user supplies its OpenAI-compatible path.
 */
function isGeminiOpenAiCompatibleEndpoint(endpointUrl: string): boolean {
  try {
    return new URL(endpointUrl).hostname === "generativelanguage.googleapis.com";
  } catch {
    return false;
  }
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
  supportedGenerationMethods?: string[] | null;
};

type ModelCatalogResponse = {
  data?: Array<ModelCatalogItem | null>;
};

type GeminiModelCatalogResponse = {
  models?: Array<ModelCatalogItem | null>;
  nextPageToken?: string | null;
};

type GeminiModelCatalogPage = {
  ids: string[];
  nextPageToken?: string;
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

function expandGeminiModelIds(ids: string[]): string[] {
  const expanded = new Set<string>();
  for (const id of ids) {
    expanded.add(id);
    if (id.startsWith("models/")) {
      expanded.add(id.slice("models/".length));
    } else {
      expanded.add(`models/${id}`);
    }
  }
  return [...expanded];
}

/**
 * Extracts safe string model IDs from the native Gemini model catalog response.
 */
function parseGeminiModelCatalogPage(body: string): GeminiModelCatalogPage {
  const parsed = parseJson<GeminiModelCatalogResponse>(body);
  const models = parsed.models ?? [];
  if (!Array.isArray(models)) {
    throw new Error("Unexpected Gemini model catalog response: expected a top-level models array");
  }
  const ids = models
    .filter(
      (item): item is ModelCatalogItem =>
        item !== null &&
        item !== undefined &&
        item.supportedGenerationMethods?.includes("generateContent") === true,
    )
    .map((item) => {
      if (typeof item.name === "string" && item.name) return item.name;
      if (typeof item.id === "string" && item.id) return item.id;
      return null;
    })
    .filter((value): value is string => Boolean(value));
  const nextPageToken =
    typeof parsed.nextPageToken === "string" && parsed.nextPageToken
      ? parsed.nextPageToken
      : undefined;
  return { ids: expandGeminiModelIds(ids), nextPageToken };
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
 * Adds a Gemini catalog page token without putting credentials in the URL.
 */
function endpointUrlWithPageToken(endpointUrl: string, pageToken: string): string {
  try {
    const url = new URL(endpointUrl);
    url.searchParams.set("pageToken", pageToken);
    return url.toString();
  } catch {
    const separator = endpointUrl.includes("?") ? "&" : "?";
    return `${endpointUrl}${separator}pageToken=${encodeURIComponent(pageToken)}`;
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
 * Fetches Gemini model IDs from the native Gemini model catalog.
 */
export function fetchGeminiModels(
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelCatalogFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const endpointUrl = GEMINI_NATIVE_MODELS_ENDPOINT_URL;
  let authConfig: CurlAuthConfig | undefined;
  try {
    const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
    authConfig = normalizedKey
      ? createCurlAuthConfig([{ kind: "header", value: `x-goog-api-key: ${normalizedKey}` }])
      : undefined;
    const ids = new Set<string>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let lastHttpStatus = 0;
    let lastCurlStatus = 0;
    for (let pageIndex = 0; pageIndex < GEMINI_MODEL_CATALOG_MAX_PAGES; pageIndex += 1) {
      const pageUrl = pageToken ? endpointUrlWithPageToken(endpointUrl, pageToken) : endpointUrl;
      const result = runCurlProbeImpl(
        ["-sS", ...getCurlTimingArgs(), ...(authConfig?.args ?? []), pageUrl],
        { trustedConfigFiles: authConfig?.trustedConfigFiles ?? [] },
      );
      lastHttpStatus = result.httpStatus;
      lastCurlStatus = result.curlStatus;
      if (!result.ok) {
        return {
          ok: false,
          message: result.message,
          httpStatus: result.httpStatus,
          curlStatus: result.curlStatus,
        };
      }
      let page: GeminiModelCatalogPage;
      try {
        page = parseGeminiModelCatalogPage(result.body);
      } catch (error) {
        return {
          ok: false,
          httpStatus: result.httpStatus,
          curlStatus: result.curlStatus,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      for (const id of page.ids) ids.add(id);
      if (!page.nextPageToken) {
        return { ok: true, ids: [...ids] };
      }
      if (seenPageTokens.has(page.nextPageToken)) {
        return {
          ok: false,
          httpStatus: result.httpStatus,
          curlStatus: result.curlStatus,
          message: `Gemini model catalog pagination repeated page token '${page.nextPageToken}'`,
        };
      }
      seenPageTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }
    return {
      ok: false,
      httpStatus: lastHttpStatus,
      curlStatus: lastCurlStatus,
      message: `Gemini model catalog pagination exceeded ${GEMINI_MODEL_CATALOG_MAX_PAGES} pages`,
    };
  } catch (error) {
    return fetchResultFromError(error);
  } finally {
    authConfig?.cleanup();
  }
}

/**
 * Validates a selected model against the native Gemini model catalog.
 */
export function validateGeminiModel(
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelValidationResult {
  const endpointUrl = GEMINI_NATIVE_MODELS_ENDPOINT_URL;
  const available = fetchGeminiModels(apiKey, options);
  if (!available.ok) {
    return {
      ok: false,
      httpStatus: available.httpStatus,
      curlStatus: available.curlStatus,
      message: `Could not validate model against ${endpointUrl}: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    httpStatus: 200,
    curlStatus: 0,
    message: `Model '${model}' is not available from Google Gemini. Checked ${endpointUrl}.`,
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
  if (isGeminiOpenAiCompatibleEndpoint(normalizedEndpointUrl)) {
    return validateGeminiModel(model, apiKey, options);
  }
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
