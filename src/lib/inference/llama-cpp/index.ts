// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBearerAuthConfig } from "../../adapters/http/auth-config";
import {
  type CurlProbeOptions,
  type CurlProbeResult,
  runCurlProbe,
} from "../../adapters/http/probe";
import {
  isSafeLlamaCppServedModelAlias,
  LLAMA_CPP_HOST_BASE_URL,
  LLAMA_CPP_PORT,
} from "./contract";

export * from "./contract";
export * from "./gguf-acquisition";
export * from "./gguf-cache-plan";
export * from "./gguf-cache-receipt";
export * from "./host-local-runtime";

type LlamaCppModelEntry = {
  id?: unknown;
  object?: unknown;
  owned_by?: unknown;
  meta?: unknown;
};

type LlamaCppModelsResponse = { data?: unknown };

export type LlamaCppAttachmentFailureReason =
  | "unreachable"
  | "authentication-required"
  | "authentication-rejected"
  | "credential-preparation"
  | "invalid-endpoint"
  | "oversized-response"
  | "probe-timeout"
  | "malformed-fingerprint"
  | "ambiguous-model"
  | "unsafe-model-alias"
  | "not-llama-cpp"
  | "conflicting-fingerprint";

export type LlamaCppAttachmentResult =
  | { ok: true; model: string }
  | {
      ok: false;
      reason: LlamaCppAttachmentFailureReason;
      message: string;
    };

export interface ProbeLlamaCppAttachmentOptions {
  requestedModel?: string | null;
  baseUrl?: string;
  runCurlProbeImpl?: (argv: string[], options?: CurlProbeOptions) => CurlProbeResult;
}

const LLAMA_CPP_META_NUMERIC_KEYS = [
  "n_vocab",
  "n_ctx",
  "n_ctx_train",
  "n_embd",
  "n_params",
  "size",
] as const;

const LLAMA_CPP_MAX_PROBE_RESPONSE_BYTES = 256 * 1024;

function failure(
  reason: LlamaCppAttachmentFailureReason,
  message: string,
): LlamaCppAttachmentResult {
  return { ok: false, reason, message };
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasNativeLlamaCppModelMetadata(entry: LlamaCppModelEntry): boolean {
  if (entry.object !== "model" || entry.owned_by !== "llamacpp") return false;
  if (!entry.meta || typeof entry.meta !== "object" || Array.isArray(entry.meta)) return false;
  const meta = entry.meta as Record<string, unknown>;
  return (
    LLAMA_CPP_META_NUMERIC_KEYS.filter(
      (key) => typeof meta[key] === "number" && Number.isFinite(meta[key]),
    ).length >= 4
  );
}

function selectModelEntry(
  entries: LlamaCppModelEntry[],
  requestedModel: string | null,
): LlamaCppModelEntry | null {
  if (requestedModel) {
    return entries.find((entry) => entry.id === requestedModel) ?? null;
  }
  return entries.length === 1 ? entries[0] : null;
}

function parseModelEntries(response: LlamaCppModelsResponse): LlamaCppModelEntry[] | null {
  if (!Array.isArray(response.data)) return null;
  const entries = response.data.filter(
    (entry): entry is LlamaCppModelEntry =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  return entries.length === response.data.length ? entries : null;
}

function hasHealthyNativeResponse(result: CurlProbeResult): boolean {
  const body = parseJsonObject(result.body);
  return result.ok && body?.status === "ok";
}

function hasMatchingNativeProps(result: CurlProbeResult, model: string): boolean {
  if (!result.ok) return false;
  const body = parseJsonObject(result.body);
  if (!body || body.model_alias !== model || typeof body.model_path !== "string") return false;
  if (typeof body.total_slots !== "number" || body.total_slots <= 0) return false;
  const defaults = body.default_generation_settings;
  return (
    defaults !== null &&
    typeof defaults === "object" &&
    !Array.isArray(defaults) &&
    (defaults as Record<string, unknown>).params !== null &&
    typeof (defaults as Record<string, unknown>).params === "object"
  );
}

function hasNativeMetricsResponse(result: CurlProbeResult): boolean {
  if (result.ok) return result.body.includes("llamacpp:");
  if (result.httpStatus !== 501) return false;
  const body = parseJsonObject(result.body);
  const error = body?.error;
  return (
    error !== null &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    (error as Record<string, unknown>).type === "not_supported_error"
  );
}

function probeArgs(authArgs: readonly string[], url: string): string[] {
  return [
    "-sS",
    "--connect-timeout",
    "2",
    "--max-time",
    "5",
    "--max-filesize",
    String(LLAMA_CPP_MAX_PROBE_RESPONSE_BYTES),
    ...authArgs,
    url,
  ];
}

function boundedProbeFailure(result: CurlProbeResult): LlamaCppAttachmentResult | null {
  if (result.curlStatus === 63) {
    return failure(
      "oversized-response",
      "A llama.cpp fingerprint response exceeded the 256 KiB probe limit.",
    );
  }
  if (result.curlStatus === 28) {
    return failure("probe-timeout", "A llama.cpp fingerprint probe exceeded its time limit.");
  }
  return null;
}

function resolveFixedLoopbackBaseUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
    parsed.port !== String(LLAMA_CPP_PORT) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  return parsed.origin;
}

/**
 * Positively identify an operator-managed llama.cpp server before attachment.
 * These cooperatively imitable signals are selection evidence, not a cryptographic
 * server identity; partial, mixed, or contradictory signals fail closed.
 */
export function probeLlamaCppAttachment(
  apiKey: string,
  options: ProbeLlamaCppAttachmentOptions = {},
): LlamaCppAttachmentResult {
  if (!apiKey.trim()) {
    return failure(
      "authentication-required",
      "A native llama.cpp API key is required for existing-server attachment.",
    );
  }
  const baseUrl = resolveFixedLoopbackBaseUrl(options.baseUrl ?? LLAMA_CPP_HOST_BASE_URL);
  if (!baseUrl) {
    return failure(
      "invalid-endpoint",
      `llama.cpp attachment is restricted to loopback port ${LLAMA_CPP_PORT}.`,
    );
  }
  const probe = options.runCurlProbeImpl ?? runCurlProbe;
  const anonymousProbeOptions: CurlProbeOptions = {
    maxResponseBytes: LLAMA_CPP_MAX_PROBE_RESPONSE_BYTES,
    pinnedAddresses: [],
  };
  const anonymousModels = probe(probeArgs([], `${baseUrl}/v1/models`), anonymousProbeOptions);
  const anonymousBoundFailure = boundedProbeFailure(anonymousModels);
  if (anonymousBoundFailure) return anonymousBoundFailure;
  if (anonymousModels.curlStatus !== 0 || anonymousModels.httpStatus === 0) {
    return failure("unreachable", `No llama.cpp server responded on fixed port ${LLAMA_CPP_PORT}.`);
  }
  if (
    anonymousModels.httpStatus !== 200 &&
    anonymousModels.httpStatus !== 401 &&
    anonymousModels.httpStatus !== 403
  ) {
    return failure(
      "not-llama-cpp",
      "The server did not return a recognizable status from the model catalog endpoint.",
    );
  }
  if (anonymousModels.httpStatus === 200) {
    const anonymousProps = probe(probeArgs([], `${baseUrl}/props`), anonymousProbeOptions);
    const anonymousPropsBoundFailure = boundedProbeFailure(anonymousProps);
    if (anonymousPropsBoundFailure) return anonymousPropsBoundFailure;
    if (anonymousProps.curlStatus !== 0 || anonymousProps.httpStatus === 0) {
      return failure(
        "not-llama-cpp",
        "The protected llama.cpp endpoint did not provide authentication evidence.",
      );
    }
    if (anonymousProps.httpStatus !== 401 && anonymousProps.httpStatus !== 403) {
      if (anonymousProps.ok) {
        return failure(
          "authentication-required",
          "The server did not require the API key for a protected llama.cpp endpoint.",
        );
      }
      return failure(
        "not-llama-cpp",
        "The protected llama.cpp endpoint did not provide authentication evidence.",
      );
    }
  }

  let auth;
  try {
    auth = createBearerAuthConfig(apiKey, { prefix: "nemoclaw-llama-cpp-probe" });
  } catch {
    return failure(
      "credential-preparation",
      "The llama.cpp credential could not be prepared for a protected probe.",
    );
  }
  try {
    const probeOptions: CurlProbeOptions = {
      maxResponseBytes: LLAMA_CPP_MAX_PROBE_RESPONSE_BYTES,
      trustedConfigFiles: auth.trustedConfigFiles,
      pinnedAddresses: [],
    };
    const authenticatedModels = probe(probeArgs(auth.args, `${baseUrl}/v1/models`), probeOptions);
    const authenticatedBoundFailure = boundedProbeFailure(authenticatedModels);
    if (authenticatedBoundFailure) return authenticatedBoundFailure;
    if (authenticatedModels.httpStatus === 401 || authenticatedModels.httpStatus === 403) {
      return failure("authentication-rejected", "The llama.cpp API key was rejected.");
    }
    if (!authenticatedModels.ok) {
      return failure(
        "not-llama-cpp",
        "The authenticated model catalog did not provide bounded llama.cpp selection evidence.",
      );
    }
    const models = parseJsonObject(authenticatedModels.body) as LlamaCppModelsResponse | null;
    if (!models || !Array.isArray(models.data)) {
      return failure(
        "malformed-fingerprint",
        "The authenticated llama.cpp model catalog was malformed.",
      );
    }
    const modelEntries = parseModelEntries(models);
    if (!modelEntries) {
      return failure(
        "malformed-fingerprint",
        "The authenticated llama.cpp model catalog was malformed.",
      );
    }
    const nativeModelEntries = modelEntries.filter(hasNativeLlamaCppModelMetadata);
    if (modelEntries.length > 0 && nativeModelEntries.length === 0) {
      return failure(
        "not-llama-cpp",
        "The model catalog did not contain native llama.cpp metadata.",
      );
    }
    if (nativeModelEntries.length !== modelEntries.length) {
      return failure(
        "conflicting-fingerprint",
        "The model catalog contained conflicting native llama.cpp evidence.",
      );
    }
    const requestedModel = options.requestedModel?.trim() || null;
    const modelEntry = selectModelEntry(modelEntries, requestedModel);
    if (!modelEntry) {
      return failure(
        "ambiguous-model",
        requestedModel
          ? "The requested served model alias was not present in the llama.cpp catalog."
          : "The llama.cpp server exposes multiple or no models; specify one served alias.",
      );
    }
    const model = typeof modelEntry.id === "string" ? modelEntry.id : "";
    if (!isSafeLlamaCppServedModelAlias(model)) {
      return failure(
        "unsafe-model-alias",
        "llama.cpp must be started with a non-path served model alias.",
      );
    }
    const health = probe(probeArgs(auth.args, `${baseUrl}/health`), probeOptions);
    const props = probe(
      probeArgs(auth.args, `${baseUrl}/props?model=${encodeURIComponent(model)}`),
      probeOptions,
    );
    const metrics = probe(
      probeArgs(auth.args, `${baseUrl}/metrics?model=${encodeURIComponent(model)}`),
      probeOptions,
    );
    for (const result of [health, props, metrics]) {
      const boundFailure = boundedProbeFailure(result);
      if (boundFailure) return boundFailure;
    }
    if (
      !hasHealthyNativeResponse(health) ||
      !hasMatchingNativeProps(props, model) ||
      !hasNativeMetricsResponse(metrics)
    ) {
      return failure(
        "conflicting-fingerprint",
        "The server returned conflicting or incomplete native llama.cpp evidence.",
      );
    }
    return { ok: true, model };
  } finally {
    auth.cleanup();
  }
}
