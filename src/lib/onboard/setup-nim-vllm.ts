// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertEndpointResolvesPublic,
  isTrustedPrivateEndpointCapability,
  type TrustedPrivateEndpointCapability,
} from "../inference/endpoint-ssrf-preflight";
import type { RequestedServingProfileModel } from "../inference/serving/requested-profile-model";
import { resolveVllmModelAlias } from "../inference/vllm-models";
import { isLoopbackHostname } from "../private-networks";
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
  /**
   * Model the serving profile requested for this run declares, when one was and
   * its backend is vLLM. A running server answers that request only if it serves
   * that model; otherwise onboarding stores a recorded route the profile does not
   * describe while the review screen still shows the profile (#9563).
   */
  servingProfileModel?: RequestedServingProfileModel | null;
}

export interface SetupNimVllmDeps {
  VLLM_PORT: number;
  runCapture(args: string[], options: { ignoreError: boolean }): string;
  getLocalProviderBaseUrl(provider: string): string | null;
  getLocalProviderValidationBaseUrl(provider: string): string | null;
  getManagedVllmProviderBinding(): {
    baseUrl: string;
    validationBaseUrl?: string;
    apiKey: string;
  } | null;
  queryVllmModels(baseUrl: string, apiKey: string): string;
  isSafeModelId(model: string): boolean;
  requireValue<T>(value: T | null | undefined, message: string): T;
  validateOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string | null,
    retryMessage?: string,
    helpUrl?: string | null,
    options?: {
      apiKey?: string | null;
      pinnedAddresses?: readonly string[];
      trustedPrivateCapability?: TrustedPrivateEndpointCapability;
    },
  ): Promise<{ ok: boolean; retry?: string; api?: string | null }>;
  applyVllmRuntimeContextWindow(models: VllmModels, model: string): void;
  isDgxSparkHost?: () => boolean;
  isNemoClawManagedVllmRunning?: () => boolean;
  persistConfiguredManagedVllmRuntimeReceipt(): Promise<
    | {
        ok: true;
        persisted: boolean;
      }
    | {
        ok: false;
        reason: string;
      }
  >;
  exitProcess(code: number): never;
}

const SPARK_LONG_CONTEXT_WARNING_THRESHOLD = 131_072;
const LARGE_MODEL_SIZE_PATTERN = /(?:^|[-_/])(\d+(?:\.\d+)?)b(?:$|[-_/])/gi;
const LARGE_MODEL_SIZE_THRESHOLD_B = 30;
const LARGE_MODEL_KEYWORD_PATTERN = /(?:^|[-_/])super(?:$|[-_/])/i;
const SAFE_REPORTED_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const NO_QUANTIZATION_VALUES = new Set(["", "false", "none", "null", "unquantized"]);

type ModelSizeClass = "large" | "small" | "unknown";

async function managedVllmValidationOptions(baseUrl: string, apiKey: string) {
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  const preflight = await assertEndpointResolvesPublic(baseUrl, undefined, {
    trustedPrivateHosts: [hostname],
  });
  if (!preflight.ok) {
    throw new Error("Managed vLLM endpoint authorization failed.");
  }
  if (
    !isLoopbackHostname(hostname) &&
    !isTrustedPrivateEndpointCapability(preflight.trustedPrivateCapability)
  ) {
    throw new Error("Managed vLLM endpoint authorization failed.");
  }
  return {
    apiKey,
    pinnedAddresses: preflight.addresses ?? [],
    trustedPrivateCapability: preflight.trustedPrivateCapability,
  };
}

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

/** Match an arbitrary served alias to the requested model through vLLM's reported root. */
function reportedModelMatchesRequest(
  models: VllmModels,
  detectedModel: string,
  requestedModel: string,
): boolean {
  if (detectedModel === requestedModel) return true;
  const root = reportedModelRoot(findVllmModelEntry(models, detectedModel));
  if (!root) return false;
  const registeredModel = resolveVllmModelAlias(requestedModel);
  return root.toLowerCase() === (registeredModel?.id ?? requestedModel).toLowerCase();
}

/**
 * A running endpoint answers a requested profile under the alias the recipe pins,
 * or under any alias whose reported root is the declared model. An endpoint that
 * reports no safe root answers only under the pinned alias.
 */
function reportedModelMatchesServingProfile(
  models: VllmModels,
  detectedModel: string,
  profile: RequestedServingProfileModel,
): boolean {
  if (detectedModel === profile.servedName) return true;
  const root = reportedModelRoot(findVllmModelEntry(models, detectedModel));
  return root !== null && root.toLowerCase() === profile.modelId.toLowerCase();
}

/** Preserve the checkpoint identity proven by the vLLM model response. */
function validatedVllmModelIdentity(
  models: VllmModels,
  detectedModel: string,
  requestedModel: string | null,
): string | null {
  const root = reportedModelRoot(findVllmModelEntry(models, detectedModel));
  if (root) return root;
  if (!requestedModel || detectedModel !== requestedModel) return null;
  const registeredModel = resolveVllmModelAlias(requestedModel);
  return registeredModel?.id ?? requestedModel;
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
    state.provider = "vllm-local";
    state.credentialEnv = null;
    let managedBinding: ReturnType<SetupNimVllmDeps["getManagedVllmProviderBinding"]>;
    try {
      managedBinding = deps.getManagedVllmProviderBinding();
    } catch {
      console.error("  Managed vLLM authentication state is unsafe or unreadable.");
      deps.exitProcess(1);
    }
    state.endpointUrl = managedBinding?.baseUrl ?? deps.getLocalProviderBaseUrl(state.provider);
    if (!state.endpointUrl) {
      console.error("  Local vLLM base URL could not be determined.");
      deps.exitProcess(1);
    }
    state.preferredInferenceApi = "openai-completions";
    state.assertRouteCompatible?.();
    const requiredModel = typeof state.model === "string" ? state.model : null;

    const validationBaseUrl =
      managedBinding?.validationBaseUrl ??
      managedBinding?.baseUrl ??
      deps.getLocalProviderValidationBaseUrl(state.provider);
    if (!validationBaseUrl) {
      console.error("  Local vLLM validation URL could not be determined.");
      deps.exitProcess(1);
    }

    const apiKey = managedBinding?.apiKey ?? null;
    const managedEndpoint = managedBinding != null;
    console.log(
      managedEndpoint
        ? "  ✓ Using managed vLLM endpoint"
        : `  ✓ Using existing vLLM on localhost:${deps.VLLM_PORT}`,
    );
    let managedValidationOptions: Awaited<ReturnType<typeof managedVllmValidationOptions>> | null =
      null;
    if (apiKey) {
      try {
        managedValidationOptions = await managedVllmValidationOptions(validationBaseUrl, apiKey);
      } catch {
        console.error("  Managed vLLM endpoint authorization could not be verified.");
        deps.exitProcess(1);
      }
    }
    const raw = apiKey
      ? deps.queryVllmModels(validationBaseUrl, apiKey)
      : deps.runCapture(["curl", "-sf", `${validationBaseUrl}/models`], {
          ignoreError: true,
        });
    let models: VllmModels;
    try {
      models = JSON.parse(raw);
    } catch {
      console.error(
        managedEndpoint
          ? "  Could not query the managed vLLM models endpoint. Is the deployment running and reachable?"
          : `  Could not query vLLM models endpoint. Is vLLM running on localhost:${deps.VLLM_PORT}?`,
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
    const servingProfile = options.servingProfileModel ?? null;
    if (
      servingProfile &&
      !reportedModelMatchesServingProfile(models, detectedModel, servingProfile)
    ) {
      const declared = `serves '${servingProfile.modelId}' as '${servingProfile.servedName}'`;
      console.error(
        managedEndpoint
          ? `  Serving profile '${servingProfile.presetId}' ${declared}, but the managed vLLM ` +
            `endpoint reports '${detectedModel}'.`
          : `  Serving profile '${servingProfile.presetId}' ${declared}, but vLLM on ` +
            `localhost:${deps.VLLM_PORT} reports '${detectedModel}'.`,
      );
      console.error(
        "  Onboarding would store that model as the sandbox's recorded route, so the agent " +
          "would use a model the profile does not declare.",
      );
      console.error(
        managedEndpoint
          ? "  Stop the managed vLLM deployment, then rerun the original install/onboard command."
          : `  Stop the existing vLLM server on localhost:${deps.VLLM_PORT}, then rerun the ` +
            "original install/onboard command.",
      );
      console.error(
        `  To keep '${detectedModel}' instead, start detailed setup without a profile:`,
      );
      console.error("    unset NEMOCLAW_SERVING_PRESET NEMOCLAW_PROVIDER");
      console.error(`    ${cliName()} onboard --fresh`);
      console.error("  Then select Local vLLM when prompted.");
      deps.exitProcess(1);
    }
    if (
      requiredModel &&
      detectedModel !== requiredModel &&
      (options.managedInstall === true ||
        managedEndpoint ||
        !reportedModelMatchesRequest(models, detectedModel, requiredModel))
    ) {
      console.error(
        `  Detected vLLM model '${detectedModel}' does not match the shared gateway route '${requiredModel}'.`,
      );
      console.error(
        managedEndpoint
          ? `  To install '${requiredModel}', stop the managed vLLM deployment, then rerun the original install/onboard command.`
          : `  To install '${requiredModel}', stop the existing vLLM server on localhost:${deps.VLLM_PORT}, then rerun the original install/onboard command.`,
      );
      console.error(`  To keep '${detectedModel}' instead, start detailed setup:`);
      console.error("    unset NEMOCLAW_PROVIDER NEMOCLAW_MODEL NEMOCLAW_VLLM_MODEL");
      console.error(`    ${cliName()} onboard --fresh`);
      console.error("  Then select Local vLLM when prompted.");
      deps.exitProcess(1);
    }
    const modelIdentity = validatedVllmModelIdentity(models, detectedModel, requiredModel);
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

    const validationModel = deps.requireValue(state.model, "Expected a detected vLLM model");
    const validation = apiKey
      ? await deps.validateOpenAiLikeSelection(
          "Local vLLM",
          validationBaseUrl,
          validationModel,
          null,
          undefined,
          undefined,
          deps.requireValue(
            managedValidationOptions,
            "Expected managed vLLM validation authorization",
          ),
        )
      : await deps.validateOpenAiLikeSelection(
          "Local vLLM",
          validationBaseUrl,
          validationModel,
          null,
        );
    if (validation.retry === "selection" || validation.retry === "model" || !validation.ok) {
      return "retry-selection";
    }

    if (managedEndpoint) {
      const receipt = await deps.persistConfiguredManagedVllmRuntimeReceipt();
      if (!receipt.ok || !receipt.persisted) {
        const reason = receipt.ok ? "the managed cleanup receipt was not written" : receipt.reason;
        console.error(`  Managed vLLM cleanup ownership could not be persisted: ${reason}`);
        deps.exitProcess(1);
      }
    }

    if (modelIdentity) state.vllmModelIdentity = modelIdentity;
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
