// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CurlProbeResult } from "../adapters/http/probe";
import { runCurlProbe } from "../adapters/http/probe";
import { isSafeModelId } from "../validation";
import { CLOUD_MODEL_OPTIONS, DEFAULT_CLOUD_MODEL } from "./config";

export const NVIDIA_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";
// GLM 5.1 retirement contract (#6069): the external featured feed may lag an
// NVIDIA Endpoints retirement. The repository authority is CLOUD_MODEL_OPTIONS
// plus the provider-boundary assertion in test/inference-options-docs.test.ts,
// which retain GLM 5.1 only for Hermes. Keep this policy deny-list until a
// deliberate product change reverses #6069; a transient feed omission alone is
// not a removal signal.
const RETIRED_NVIDIA_FEATURED_MODEL_IDS = new Set(["z-ai/glm-5.1"]);
const MAX_NVIDIA_FEATURED_CATALOG_BYTES = 1024 * 1024;
const MAX_NVIDIA_FEATURED_MODELS = 100;
const MAX_NVIDIA_FEATURED_MODEL_ID_LENGTH = 256;
const MAX_NVIDIA_FEATURED_MODEL_LABEL_LENGTH = 160;
const ANSI_ESCAPE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const UNSAFE_TERMINAL_TEXT_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

interface NvidiaFeaturedModelOptions {
  runCurlProbeImpl?: (argv: string[]) => CurlProbeResult;
  warn?: (message: string) => void;
}

type FeaturedModelCatalogItem = {
  model?: string | null;
  "model-name"?: string | null;
};

type FeaturedModelCatalogResponse = {
  "featured-models"?: Array<FeaturedModelCatalogItem | null>;
};

export type FeaturedModelOption = {
  id: string;
  label: string;
};

export type FeaturedModelFetchResult =
  | {
      ok: true;
      models: FeaturedModelOption[];
    }
  | {
      ok: false;
      message: string;
      httpStatus: number;
      curlStatus: number;
    };

/** Normalizes NVIDIA featured-model catalog IDs into endpoint model IDs. */
function normalizeFeaturedModelId(model: string): string {
  const trimmed = model.trim();
  // Minimax rollout contract (#5827): the external feed has emitted the stale
  // M2.7 ID/label while CLOUD_MODEL_OPTIONS and the task-fit docs define M3 as
  // the NVIDIA Endpoints choice. This is an upstream-lag bridge; remove this ID
  // rewrite together with the label rewrite and fixture only once the feed no
  // longer emits M2.7 and publishes M3 directly.
  if (trimmed === "minimaxai/minimax-m2.7") {
    return "minimaxai/minimax-m3";
  }
  // Nemotron namespace contract (#5827): the external feed has emitted bare
  // nemotron-3-* IDs, while CLOUD_MODEL_OPTIONS and the matching OpenClaw
  // model-specific setup manifest use the canonical nvidia/ endpoint namespace.
  // The feed can lag that repository contract; remove this bridge and its
  // bare-ID fixture only once affected entries no longer emit bare IDs and use
  // the namespaced form.
  if (/^nemotron-3-/i.test(trimmed)) {
    return `nvidia/${trimmed}`;
  }
  return trimmed;
}

function sanitizeFeaturedCatalogText(value: string, maxLength: number): string {
  return value
    .replace(ANSI_ESCAPE_RE, "")
    .replace(UNSAFE_TERMINAL_TEXT_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Normalizes NVIDIA featured-model labels for known catalog lag cases. */
function normalizeFeaturedModelLabel(id: string, label: string): string {
  const sanitized = sanitizeFeaturedCatalogText(label, MAX_NVIDIA_FEATURED_MODEL_LABEL_LENGTH);
  // Keep the display label coupled to the Minimax rollout contract above.
  if (id === "minimaxai/minimax-m3" && /^minimax m2\.7$/i.test(sanitized)) {
    return "Minimax M3";
  }
  return sanitized;
}

/** Parses NVIDIA's featured-models catalog into safe onboarding menu options. */
export function parseNvidiaFeaturedModels(body: string): FeaturedModelOption[] {
  if (Buffer.byteLength(body, "utf8") > MAX_NVIDIA_FEATURED_CATALOG_BYTES) {
    throw new Error("Unexpected featured model catalog response: body exceeds 1 MiB");
  }
  const parsed = JSON.parse(body) as FeaturedModelCatalogResponse;
  const featuredModels = parsed["featured-models"];
  if (!Array.isArray(featuredModels)) {
    throw new Error('Unexpected featured model catalog response: expected "featured-models" array');
  }

  const models: FeaturedModelOption[] = [];
  const seenIds = new Set<string>();
  for (const item of featuredModels) {
    const id = typeof item?.model === "string" ? normalizeFeaturedModelId(item.model) : "";
    const idKey = id.toLowerCase();
    const label =
      typeof item?.["model-name"] === "string"
        ? normalizeFeaturedModelLabel(id, item["model-name"])
        : "";
    if (
      !id ||
      id.length > MAX_NVIDIA_FEATURED_MODEL_ID_LENGTH ||
      !label ||
      !isSafeModelId(id) ||
      RETIRED_NVIDIA_FEATURED_MODEL_IDS.has(idKey) ||
      seenIds.has(idKey)
    ) {
      continue;
    }
    models.push({ id, label });
    seenIds.add(idKey);
    if (models.length >= MAX_NVIDIA_FEATURED_MODELS) break;
  }
  return models;
}

/** Fetches NVIDIA's public featured-models catalog without credentials. */
export function fetchNvidiaFeaturedModels(
  options: NvidiaFeaturedModelOptions = {},
): FeaturedModelFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  try {
    const result = runCurlProbeImpl([
      "-sS",
      "--connect-timeout",
      "5",
      "--max-time",
      "15",
      NVIDIA_FEATURED_MODELS_URL,
    ]);
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        httpStatus: result.httpStatus,
        curlStatus: result.curlStatus,
      };
    }
    try {
      return { ok: true, models: parseNvidiaFeaturedModels(result.body) };
    } catch (error) {
      return {
        ok: false,
        httpStatus: result.httpStatus,
        curlStatus: result.curlStatus,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Returns live featured NVIDIA models, falling back to the curated snapshot. */
export function getNvidiaFeaturedModelOptions(
  options: NvidiaFeaturedModelOptions = {},
): FeaturedModelOption[] {
  const result = fetchNvidiaFeaturedModels(options);
  if (result.ok && result.models.length > 0) {
    return result.models;
  }
  const detail = result.ok
    ? "catalog returned no safe model IDs"
    : `${sanitizeFeaturedCatalogText(result.message, 200) || "catalog request failed without details"}${result.httpStatus > 0 ? `; HTTP ${result.httpStatus}` : ""}`;
  (options.warn ?? console.warn)(
    `  Warning: failed to load NVIDIA's featured model catalog; falling back to the bundled list (${detail}).`,
  );
  return CLOUD_MODEL_OPTIONS;
}

function buildNvidiaFeaturedModelPromptOptions(
  defaultModelId: string | null | undefined,
  cloudModelOptions: FeaturedModelOption[],
): {
  defaultModelId: string;
  cloudModelOptions: FeaturedModelOption[];
} {
  const preferredDefault = defaultModelId || DEFAULT_CLOUD_MODEL;
  const effectiveDefault = cloudModelOptions.some((option) => option.id === preferredDefault)
    ? preferredDefault
    : (cloudModelOptions[0]?.id ?? preferredDefault);
  return { defaultModelId: effectiveDefault, cloudModelOptions };
}

/** Builds NVIDIA Endpoints prompt options from the featured-models catalog. */
export function getNvidiaFeaturedModelPromptOptions(
  defaultModelId?: string | null,
  options: NvidiaFeaturedModelOptions = {},
): {
  defaultModelId: string;
  cloudModelOptions: FeaturedModelOption[];
} {
  return buildNvidiaFeaturedModelPromptOptions(
    defaultModelId,
    getNvidiaFeaturedModelOptions(options),
  );
}

/** Caches one featured-model catalog lookup for a single onboarding session. */
export function createNvidiaFeaturedModelPromptOptionsLoader(
  options: NvidiaFeaturedModelOptions = {},
): (defaultModelId?: string | null) => ReturnType<typeof getNvidiaFeaturedModelPromptOptions> {
  let cachedModels: FeaturedModelOption[] | null = null;
  return (defaultModelId?: string | null) => {
    cachedModels ??= getNvidiaFeaturedModelOptions(options);
    return buildNvidiaFeaturedModelPromptOptions(defaultModelId, cachedModels);
  };
}
