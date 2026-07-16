// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cliName } from "./branding";
import type { SetupNimSelectionResult, SetupNimSelectionState } from "./setup-nim-flow";

type VllmModelEntry = {
  id?: unknown;
  root?: unknown;
  max_model_len?: unknown;
  quantization?: unknown;
  config?: unknown;
  model_config?: unknown;
};
type VllmModels = { data?: VllmModelEntry[] };

export interface SetupNimVllmSelectionOptions {
  managedInstall?: boolean;
  /** True when the already-detected GPU confirms DGX Spark (covers firmware-unknown GB10 hosts). */
  sparkHost?: boolean;
}

export interface SetupNimVllmDeps {
  VLLM_PORT: number;
  runCapture(args: string[], options: { ignoreError: boolean }): string;
  getLocalProviderBaseUrl(provider: string): string | null;
  getLocalProviderValidationBaseUrl(provider: string): string | null;
  isSafeModelId(model: string): boolean;
  requireValue<T>(value: T | null | undefined, message: string): T;
  validateOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string | null,
  ): Promise<{ ok: boolean; retry?: string; api?: string | null }>;
  applyVllmRuntimeContextWindow(models: VllmModels, model: string): void;
  isDgxSparkHost?: () => boolean;
  isNemoClawManagedVllmRunning?: () => boolean;
  exitProcess(code: number): never;
}

const SPARK_LONG_CONTEXT_WARNING_THRESHOLD = 131_072;
const LARGE_MODEL_SIZE_PATTERN = /(?:^|[-_/])(\d+(?:\.\d+)?)b(?:$|[-_/])/gi;
const LARGE_MODEL_SIZE_THRESHOLD_B = 30;
const LARGE_MODEL_KEYWORD_PATTERN = /(?:^|[-_/])super(?:$|[-_/])/i;
const SAFE_REPORTED_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const NO_QUANTIZATION_VALUES = new Set(["", "false", "none", "null", "unquantized"]);

type ModelSizeClass = "large" | "small" | "unknown";

/** Parse positive integer metadata reported by vLLM model endpoints. */
function parsePositiveInteger(value: unknown): number | null {
  const normalized = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

/** Find the `/v1/models` entry that corresponds to the selected served model ID. */
function findVllmModelEntry(models: VllmModels, detectedModel: string): VllmModelEntry | null {
  const entries = Array.isArray(models.data) ? models.data : [];
  return (
    entries.find((entry) => String(entry?.id ?? "").trim() === detectedModel) ??
    (entries.length === 1 ? entries[0] : null)
  );
}

/** Classify an underlying model root by size, keeping arbitrary aliases unknown. */
function classifyModelSize(model: string): ModelSizeClass {
  let sawNumericSize = false;
  for (const match of model.matchAll(LARGE_MODEL_SIZE_PATTERN)) {
    const sizeBillions = Number(match[1]);
    if (Number.isFinite(sizeBillions)) {
      sawNumericSize = true;
      if (sizeBillions >= LARGE_MODEL_SIZE_THRESHOLD_B) return "large";
    }
  }
  if (LARGE_MODEL_KEYWORD_PATTERN.test(model)) return "large";
  return sawNumericSize ? "small" : "unknown";
}

/** Return the reported underlying model root only when it is a safe model identifier. */
function reportedModelRoot(entry: VllmModelEntry | null): string | null {
  const root = typeof entry?.root === "string" ? entry.root.trim() : "";
  return root && SAFE_REPORTED_MODEL_ID_PATTERN.test(root) ? root : null;
}

/** Read a string property from optional nested vLLM model metadata. */
function readObjectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate.trim() : null;
}

/** Resolve quantization metadata from direct and nested vLLM model fields. */
function reportedQuantization(entry: VllmModelEntry | null): string | null {
  const direct = typeof entry?.quantization === "string" ? entry.quantization.trim() : null;
  const configured =
    readObjectString(entry?.model_config, "quantization") ??
    readObjectString(entry?.config, "quantization");
  const quantization = direct ?? configured;
  if (!quantization || NO_QUANTIZATION_VALUES.has(quantization.toLowerCase())) return null;
  return quantization;
}

/** Build the DGX Spark headroom warning for an existing, unmanaged vLLM server. */
export function buildDgxSparkExistingVllmHeadroomWarning(
  models: VllmModels,
  detectedModel: string,
): string | null {
  const model = detectedModel.trim();
  if (!model) return null;

  const entry = findVllmModelEntry(models, model);
  const root = reportedModelRoot(entry);
  const modelSize = root ? classifyModelSize(root) : "unknown";
  const quantization = reportedQuantization(entry);
  const maxModelLen = parsePositiveInteger(entry?.max_model_len);
  const longContext = !!maxModelLen && maxModelLen >= SPARK_LONG_CONTEXT_WARNING_THRESHOLD;

  // The served ID is an arbitrary alias and can never prove model size or
  // quantization. Fail conservatively when vLLM omits its underlying model root.
  const riskyLargeModel = modelSize === "large" && !quantization;
  const unverifiableModel = modelSize === "unknown";
  if (!riskyLargeModel && !unverifiableModel && !longContext) return null;

  const contextText = maxModelLen ? ` with max_model_len=${String(maxModelLen)}` : "";
  const rootText = root && root !== model ? ` (underlying model '${root}')` : "";
  const contextHint = longContext
    ? " The reported context window is very large for a unified-memory host."
    : "";
  const riskDescription = unverifiableModel
    ? "vLLM did not report enough model metadata to verify the underlying model size"
    : riskyLargeModel
      ? "Model metadata heuristically indicates a large checkpoint without reported quantization configuration"
      : "High-context configurations";

  return (
    `  ! Existing vLLM on DGX Spark is serving '${model}'${rootText}${contextText}. ` +
    `${riskDescription}. This configuration can leave too little unified-memory headroom and may surface ` +
    "as NVRM NV_ERR_NO_MEMORY or a hard host freeze under agent/tool load." +
    contextHint +
    " Prefer the managed Spark vLLM path (NEMOCLAW_PROVIDER=install-vllm) or restart vLLM " +
    "with lower --gpu-memory-utilization, --max-model-len, --max-num-seqs, and " +
    "--max-num-batched-tokens before onboarding."
  );
}

/** Create the Local vLLM onboarding handler, including Spark-specific safety warnings. */
export function createSetupNimVllmHandler(
  deps: SetupNimVllmDeps,
): (
  state: SetupNimSelectionState,
  options?: SetupNimVllmSelectionOptions,
) => Promise<SetupNimSelectionResult> {
  return async function handleVllmSelection(
    state: SetupNimSelectionState,
    options: SetupNimVllmSelectionOptions = {},
  ): Promise<SetupNimSelectionResult> {
    console.log(`  ✓ Using existing vLLM on localhost:${deps.VLLM_PORT}`);
    state.provider = "vllm-local";
    state.credentialEnv = null;
    state.endpointUrl = deps.getLocalProviderBaseUrl(state.provider);
    if (!state.endpointUrl) {
      console.error("  Local vLLM base URL could not be determined.");
      deps.exitProcess(1);
    }
    state.preferredInferenceApi = "openai-completions";
    state.assertRouteCompatible?.();
    const requiredModel = typeof state.model === "string" ? state.model : null;

    const raw = deps.runCapture(["curl", "-sf", `http://127.0.0.1:${deps.VLLM_PORT}/v1/models`], {
      ignoreError: true,
    });
    let models: VllmModels;
    try {
      models = JSON.parse(raw);
    } catch {
      console.error(
        `  Could not query vLLM models endpoint. Is vLLM running on localhost:${deps.VLLM_PORT}?`,
      );
      deps.exitProcess(1);
    }
    const detectedModel =
      models.data && models.data.length > 0 && typeof models.data[0]?.id === "string"
        ? models.data[0].id
        : null;
    if (!detectedModel) {
      console.error("  Could not detect model from vLLM. Please specify manually.");
      deps.exitProcess(1);
    }
    if (!deps.isSafeModelId(detectedModel)) {
      console.error("  Detected vLLM model ID contains invalid characters.");
      deps.exitProcess(1);
    }
    if (requiredModel && detectedModel !== requiredModel) {
      console.error(
        `  Detected vLLM model '${detectedModel}' does not match the shared gateway route '${requiredModel}'.`,
      );
      console.error(
        `  To install '${requiredModel}', stop the existing vLLM server on localhost:${deps.VLLM_PORT}, then rerun the original install/onboard command.`,
      );
      console.error(`  To keep '${detectedModel}' instead, start detailed setup:`);
      console.error("    unset NEMOCLAW_PROVIDER NEMOCLAW_MODEL NEMOCLAW_VLLM_MODEL");
      console.error(`    ${cliName()} onboard --fresh`);
      console.error("  Then select Local vLLM when prompted.");
      deps.exitProcess(1);
    }
    state.model = detectedModel;
    state.assertRouteCompatible?.();
    console.log(`  Detected model: ${state.model}`);
    // options.sparkHost carries the already-detected GPU result (covers firmware-unknown
    // GB10 hosts that detectNvidiaPlatform() alone would miss); fall back to the dep.
    const isSparkHost =
      options.sparkHost !== undefined ? options.sparkHost : (deps.isDgxSparkHost?.() ?? false);
    if (isSparkHost) {
      const managedByNemoClaw =
        options.managedInstall === true || deps.isNemoClawManagedVllmRunning?.() === true;
      if (!managedByNemoClaw) {
        const warning = buildDgxSparkExistingVllmHeadroomWarning(models, detectedModel);
        if (warning) console.warn(warning);
      }
    }

    const validationBaseUrl = deps.getLocalProviderValidationBaseUrl(state.provider);
    if (!validationBaseUrl) {
      console.error("  Local vLLM validation URL could not be determined.");
      deps.exitProcess(1);
    }
    const validation = await deps.validateOpenAiLikeSelection(
      "Local vLLM",
      validationBaseUrl,
      deps.requireValue(state.model, "Expected a detected vLLM model"),
      null,
    );
    if (validation.retry === "selection" || validation.retry === "model" || !validation.ok) {
      return "retry-selection";
    }

    deps.applyVllmRuntimeContextWindow(models, state.model);
    if (validation.api !== "openai-completions") {
      console.log(
        "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
      );
    }
    state.preferredInferenceApi = "openai-completions";
    return "selected";
  };
}
