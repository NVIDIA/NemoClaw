// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalEndpoint,
  normalizeProviderBaseUrl,
  unsafeEndpointUrlViolation,
} from "../core/url-utils";
import { applyCompatibleEndpointContextWindow } from "../inference/compatible-endpoint-context";
import type { TrustedPrivateEndpointCapability } from "../inference/endpoint-ssrf-preflight";
import type { GatewayRouteDiscoveryConstraints } from "../inference/gateway-route-compatibility";
import { getProbeExtraHeaders } from "../inference/onboard-probes";
import { usesNvidiaEndpointProbePayload } from "../inference/openai-probe-models";
import type { OnboardInferenceCapabilityCache } from "./inference-capability-cache";
import type { NvidiaFeaturedModelSession } from "./nvidia-featured-model-selection";
import { exitOnboardFromPrompt, getNavigationChoice } from "./prompt-helpers";
import type { ReasoningEffort } from "./reasoning-mode";

export {
  createNvidiaFeaturedModelSession,
  selectFeaturedModelAfterCredentialPrompt,
} from "./nvidia-featured-model-selection";

export type SetupNimSelectionBackNavigation = Readonly<{ kind: "NEMOCLAW_BACK_TO_SELECTION" }>;

/** Defaults passed into Ollama model selection and runtime context adoption. */
export type OllamaModelSelectionDefaults = {
  requestedModel: string | null;
  recoveredModel: string | null;
  lockedModel?: string | null;
  /** Minimum runtime context window required by the selected agent. */
  contextWindowFloor?: number;
  /** Interactive prompt default from provider/model environment variables. */
  promptDefaultModel?: string | null;
};

export type SetupNimSelectionState<THermesAuthMethod = unknown> = {
  model: string | SetupNimSelectionBackNavigation | null;
  provider: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: THermesAuthMethod | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning?: string | null;
  compatibleEndpointReasoningEffort?: string | null;
  nimContainer: string | null;
  allowToolsIncompatible: boolean;
  /** Minimum Ollama daemon context length to request for this agent. */
  ollamaContextWindowFloor?: number;
  skipHostInferenceSmoke?: boolean;
  /** Public addresses approved for the selected custom endpoint. */
  endpointPinnedAddresses?: string[];
  /** Non-forgeable proof of the exact host and complete pins admitted by the selected preflight. */
  endpointTrustedPrivateCapability?: TrustedPrivateEndpointCapability;
  reuseGatewayCredentialWithoutLocalKey?: boolean;
  /** Ephemeral selection-to-smoke validation cache; never written to session state. */
  inferenceCapabilityCache?: OnboardInferenceCapabilityCache;
  /** Route-validated vLLM checkpoint identity; ephemeral and never persisted directly. */
  vllmModelIdentity?: string;
  nvidiaFeaturedModels?: NvidiaFeaturedModelSession;
  openRouterFeaturedModels?: NvidiaFeaturedModelSession;
  /** Attempt-wide shared-gateway guard, invoked after identity selection and before probes. */
  assertRouteCompatible?: () => GatewayRouteDiscoveryConstraints;
  /** Receipt-bound policy check invoked immediately before provider or runtime mutations. */
  revalidateSandboxIdentity?: (operation: string) => void;
};

/** Revalidate the current provider selection before a policy-dependent mutation. */
export function assertSelectionMutationAuthority(
  state: SetupNimSelectionState,
  operation: string,
): void {
  state.revalidateSandboxIdentity?.(operation);
}

/** Carry the attempt's exact mutation guard through a blocking credential prompt. */
export function credentialMutationGuardFor(
  state: SetupNimSelectionState,
): ((operation: string) => void) | undefined {
  return state.revalidateSandboxIdentity;
}

export function withCredentialMutationGuard<T extends object>(
  state: SetupNimSelectionState,
  options: T,
): T & { revalidateSandboxIdentity?: (operation: string) => void } {
  const guard = credentialMutationGuardFor(state);
  return guard ? { ...options, revalidateSandboxIdentity: guard } : options;
}

export type CloudFallbackConfig = {
  providerName: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  defaultModel: string;
};

export function applyCloudFallbackSelection(
  state: SetupNimSelectionState,
  cloudConfig: CloudFallbackConfig,
): void {
  // Source boundary: fallback may run after a local Ollama/NIM/vLLM branch
  // accepted provider-specific tool constraints. Cloud fallback is a fresh
  // provider selection, so clear local-only compatibility state here.
  state.provider = cloudConfig.providerName;
  state.endpointUrl = cloudConfig.endpointUrl;
  state.credentialEnv = cloudConfig.credentialEnv;
  state.model = cloudConfig.defaultModel;
  state.preferredInferenceApi = null;
  state.nimContainer = null;
  state.allowToolsIncompatible = false;
  state.skipHostInferenceSmoke = false;
  state.reuseGatewayCredentialWithoutLocalKey = false;
  delete state.vllmModelIdentity;
  delete state.endpointPinnedAddresses;
  delete state.endpointTrustedPrivateCapability;
}

export function clearNimContainerBeforeRetry(state: SetupNimSelectionState): void {
  state.nimContainer = null;
}

type CompatibleEndpointKind = "openai" | "anthropic";

export async function resolveCompatibleEndpointInput(args: {
  kind: CompatibleEndpointKind;
  envUrl: string | null | undefined;
  recoveredEndpointUrl: string | null | undefined;
  nonInteractive: boolean;
  prompt: (message: string) => Promise<string>;
}): Promise<string> {
  const envInput = args.envUrl || "";
  const recoveredInput = args.recoveredEndpointUrl || "";
  const envUrl = envInput.trim();
  const recoveredUrl = recoveredInput.trim();
  const defaultEndpointUrl = envUrl || recoveredUrl;
  const defaultEndpointInput = envUrl ? envInput : recoveredUrl ? recoveredInput : "";
  if (args.nonInteractive) return defaultEndpointInput;
  return (
    (await args.prompt(
      defaultEndpointUrl
        ? `  ${args.kind === "openai" ? "OpenAI" : "Anthropic"}-compatible base URL [${defaultEndpointUrl}]: `
        : args.kind === "openai"
          ? "  OpenAI-compatible base URL (e.g., https://openrouter.ai): "
          : "  Anthropic-compatible base URL (e.g., https://proxy.example.com): ",
    )) || defaultEndpointInput
  );
}

export type CompatibleEndpointSelection =
  | { action: "retry-selection" }
  | { action: "selected"; endpointUrl: string };

/**
 * Resolve and validate the compatible-endpoint base URL: handle back/exit
 * navigation, reject inputs that carry components NemoClaw cannot forward
 * (#9106), and require a non-empty normalized base URL.
 */
export async function resolveCompatibleEndpointSelection(args: {
  kind: CompatibleEndpointKind;
  envUrl: string | null | undefined;
  recoveredEndpointUrl: string | null | undefined;
  nonInteractive: boolean;
  prompt: (message: string) => Promise<string>;
}): Promise<CompatibleEndpointSelection> {
  const endpointInput = await resolveCompatibleEndpointInput(args);
  const navigation = getNavigationChoice(endpointInput);
  if (navigation === "back") {
    console.log("  Returning to provider selection.");
    console.log("");
    return { action: "retry-selection" };
  }
  if (navigation === "exit") {
    exitOnboardFromPrompt();
  }
  // #9106/#9301: reject unsafe endpoint input here, before any network
  // request, provider registration, registry write, or sandbox mutation.
  const endpointViolation = unsafeEndpointUrlViolation(endpointInput);
  if (endpointViolation) {
    console.error(`  Endpoint URL ${endpointViolation.reason}`);
    if (endpointViolation.kind === "userinfo-query-fragment") {
      // canonicalEndpoint returns null unless the stripped base is a
      // credential-free http(s) URL, so the hint never echoes userinfo or
      // query values.
      const strippedBaseUrl = canonicalEndpoint(
        normalizeProviderBaseUrl(endpointInput, args.kind),
        args.kind,
      );
      if (strippedBaseUrl) {
        console.error(
          `  NemoClaw does not forward these components to the endpoint. Use: ${strippedBaseUrl}`,
        );
      }
    }
    if (args.nonInteractive) {
      process.exit(1);
    }
    console.log("");
    return { action: "retry-selection" };
  }
  const endpointUrl = normalizeProviderBaseUrl(endpointInput, args.kind);
  if (!endpointUrl) {
    console.error(
      args.kind === "openai"
        ? "  Endpoint URL is required for Other OpenAI-compatible endpoint."
        : "  Endpoint URL is required for Other Anthropic-compatible endpoint.",
    );
    if (args.nonInteractive) {
      process.exit(1);
    }
    console.log("");
    return { action: "retry-selection" };
  }
  return { action: "selected", endpointUrl };
}

type ProviderChoice = {
  key: string;
};

export function requireProviderChoice<T extends ProviderChoice>(selected: T | undefined): T {
  if (!selected) {
    console.error("  No provider was selected.");
    process.exit(1);
  }
  return selected;
}

type RemoteProviderConfig = {
  label: string;
  endpointUrl: string;
  helpUrl: string | null;
};

type ProbeAuthMode = "bearer" | "query-param" | undefined;

type ProbeOptions = {
  requireResponsesToolCalling?: boolean;
  skipResponsesProbe?: boolean;
  useNvidiaEndpointProbePayload?: boolean;
  authMode?: ProbeAuthMode;
  extraHeaders?: readonly string[];
  capabilityCache?: OnboardInferenceCapabilityCache;
  provider?: string;
  revalidateSandboxIdentity?: (operation: string) => void;
};

type ValidationResult =
  | {
      ok: true;
      api: string | null;
      retry?: never;
      pinnedAddresses?: string[];
      trustedPrivateCapability?: TrustedPrivateEndpointCapability;
    }
  | { ok: false; api?: string; retry?: "credential" | "retry" | "model" | "selection" | string };

type RemoteModelValidationResult = "selected" | "retry-model" | "retry-selection";

type RemoteModelValidatorDeps = {
  OPENAI_ENDPOINT_URL: string;
  ANTHROPIC_ENDPOINT_URL: string;
  requireValue: <T>(value: T | null | undefined, message: string) => T;
  isBackToSelection: (value: unknown) => value is SetupNimSelectionBackNavigation;
  validateCustomOpenAiLikeSelection: (
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl: string | null,
    capabilityCache?: OnboardInferenceCapabilityCache,
    revalidateSandboxIdentity?: (operation: string) => void,
  ) => Promise<ValidationResult>;
  validateCustomAnthropicSelection: (
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl: string | null,
    options?: {
      intendedApi?: "anthropic-messages" | "openai-completions";
      revalidateSandboxIdentity?: (operation: string) => void;
    },
  ) => Promise<ValidationResult>;
  validateAnthropicSelectionWithRetryMessage: (
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    retryMessage: string,
    helpUrl: string | null,
    revalidateSandboxIdentity?: (operation: string) => void,
  ) => Promise<ValidationResult>;
  validateOpenAiLikeSelection: (
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string | null,
    retryMessage?: string,
    helpUrl?: string | null,
    options?: ProbeOptions,
  ) => Promise<ValidationResult>;
  shouldRequireResponsesToolCalling: (provider: string) => boolean;
  shouldSkipResponsesProbe: (provider: string) => boolean;
  getProbeAuthMode: (provider: string) => ProbeAuthMode;
  getProbeExtraHeaders?: (provider: string) => readonly string[];
  configureCompatibleEndpointReasoning?: () => Promise<"true" | "false">;
  configureCompatibleEndpointReasoningEffort?: () => Promise<ReasoningEffort | null>;
  log?: (message: string) => void;
};

type ValidateSelectedRemoteModelArgs = {
  selected: ProviderChoice;
  remoteConfig: RemoteProviderConfig;
  state: SetupNimSelectionState;
  selectedCredentialEnv: string;
  intendedInferenceApi?: string | null;
};

function shouldRetryModel(validation: ValidationResult): boolean {
  return (
    !validation.ok &&
    (validation.retry === "credential" ||
      validation.retry === "retry" ||
      validation.retry === "model")
  );
}

function requireCustomAnthropicRuntimeApi(
  value: string | null,
): "anthropic-messages" | "openai-completions" {
  if (value === "anthropic-messages" || value === "openai-completions") return value;
  throw new Error(`Unsupported custom Anthropic runtime API: ${String(value)}`);
}

export function createRemoteModelValidator(deps: RemoteModelValidatorDeps): {
  validateSelectedRemoteModel: (
    args: ValidateSelectedRemoteModelArgs,
  ) => Promise<RemoteModelValidationResult>;
} {
  return {
    validateSelectedRemoteModel: async ({
      selected,
      remoteConfig,
      state,
      selectedCredentialEnv,
      intendedInferenceApi = "anthropic-messages",
    }) => {
      delete state.endpointPinnedAddresses;
      delete state.endpointTrustedPrivateCapability;
      const selectedModel = deps.requireValue(
        deps.isBackToSelection(state.model) ? null : state.model,
        `Missing model for ${remoteConfig.label}`,
      );
      if (selected.key === "custom") {
        // Reasoning mode is OpenAI-compatible only; Anthropic/native providers use other formats.
        const reasoning = await deps.configureCompatibleEndpointReasoning?.();
        if (reasoning) {
          state.compatibleEndpointReasoning = reasoning;
        }
        const reasoningEffort = await deps.configureCompatibleEndpointReasoningEffort?.();
        state.compatibleEndpointReasoningEffort = reasoningEffort ?? null;
        if (reasoning === "true") {
          (deps.log ?? console.log)(
            "  ⚠ Reasoning mode validates Chat Completions only; tools and streaming are unverified.",
          );
        }
        const validationArgs = [
          remoteConfig.label,
          state.endpointUrl || deps.OPENAI_ENDPOINT_URL,
          selectedModel,
          selectedCredentialEnv,
          remoteConfig.helpUrl,
          state.inferenceCapabilityCache,
        ] as const;
        const guard = credentialMutationGuardFor(state);
        const validation = await (guard
          ? deps.validateCustomOpenAiLikeSelection(...validationArgs, guard)
          : deps.validateCustomOpenAiLikeSelection(...validationArgs));
        if (validation.ok) {
          if (validation.pinnedAddresses)
            state.endpointPinnedAddresses = validation.pinnedAddresses;
          else delete state.endpointPinnedAddresses;
          if (validation.trustedPrivateCapability)
            state.endpointTrustedPrivateCapability = validation.trustedPrivateCapability;
          else delete state.endpointTrustedPrivateCapability;
          // Probe the endpoint's runtime max_model_len so a custom vLLM endpoint
          // gets its real context window baked in instead of a small
          // architecture default; an explicit override always wins (#6177).
          await applyCompatibleEndpointContextWindow(
            state.endpointUrl || deps.OPENAI_ENDPOINT_URL,
            selectedModel,
            { credentialEnv: selectedCredentialEnv },
          );
          const explicitApi = (process.env.NEMOCLAW_PREFERRED_API || "").trim().toLowerCase();
          if (
            explicitApi &&
            explicitApi !== "openai-completions" &&
            explicitApi !== "chat-completions"
          ) {
            state.preferredInferenceApi = validation.api;
          } else {
            if (validation.api !== "openai-completions") {
              console.log(
                "  ℹ Using chat completions API (compatible endpoints may not support the Responses API developer role)",
              );
            }
            state.preferredInferenceApi = "openai-completions";
          }
          return "selected";
        }
        if (shouldRetryModel(validation)) {
          return "retry-model";
        }
        return validation.retry === "selection" ? "retry-selection" : "retry-model";
      }

      if (selected.key === "anthropicCompatible") {
        const intendedApi = requireCustomAnthropicRuntimeApi(intendedInferenceApi);
        const validation = await deps.validateCustomAnthropicSelection(
          remoteConfig.label,
          state.endpointUrl || deps.ANTHROPIC_ENDPOINT_URL,
          selectedModel,
          selectedCredentialEnv,
          remoteConfig.helpUrl,
          withCredentialMutationGuard(state, { intendedApi }),
        );
        if (validation.ok) {
          if (validation.pinnedAddresses)
            state.endpointPinnedAddresses = validation.pinnedAddresses;
          else delete state.endpointPinnedAddresses;
          if (validation.trustedPrivateCapability)
            state.endpointTrustedPrivateCapability = validation.trustedPrivateCapability;
          else delete state.endpointTrustedPrivateCapability;
          state.preferredInferenceApi = validation.api;
          return "selected";
        }
        if (shouldRetryModel(validation)) {
          return "retry-model";
        }
        return validation.retry === "selection" ? "retry-selection" : "retry-model";
      }

      const retryMessage = "Please choose a provider/model again.";
      if (selected.key === "anthropic") {
        const validationArgs = [
          remoteConfig.label,
          state.endpointUrl || deps.ANTHROPIC_ENDPOINT_URL,
          selectedModel,
          selectedCredentialEnv,
          retryMessage,
          remoteConfig.helpUrl,
        ] as const;
        const guard = credentialMutationGuardFor(state);
        const validation = await (guard
          ? deps.validateAnthropicSelectionWithRetryMessage(...validationArgs, guard)
          : deps.validateAnthropicSelectionWithRetryMessage(...validationArgs));
        if (validation.ok) {
          state.preferredInferenceApi = validation.api;
          return "selected";
        }
        if (shouldRetryModel(validation)) {
          return "retry-model";
        }
        return "retry-selection";
      }

      const validation = await deps.validateOpenAiLikeSelection(
        remoteConfig.label,
        deps.requireValue(state.endpointUrl, `Missing endpoint URL for ${remoteConfig.label}`),
        selectedModel,
        selectedCredentialEnv,
        retryMessage,
        remoteConfig.helpUrl,
        withCredentialMutationGuard(state, {
          provider: state.provider,
          useNvidiaEndpointProbePayload: usesNvidiaEndpointProbePayload(state.provider),
          requireResponsesToolCalling: deps.shouldRequireResponsesToolCalling(state.provider),
          skipResponsesProbe: deps.shouldSkipResponsesProbe(state.provider),
          authMode: deps.getProbeAuthMode(state.provider),
          extraHeaders:
            deps.getProbeExtraHeaders?.(state.provider) ?? getProbeExtraHeaders(state.provider),
          capabilityCache: state.inferenceCapabilityCache,
        }),
      );
      if (validation.ok) {
        state.preferredInferenceApi = validation.api;
        return "selected";
      }
      if (shouldRetryModel(validation)) {
        return "retry-model";
      }
      return "retry-selection";
    },
  };
}
