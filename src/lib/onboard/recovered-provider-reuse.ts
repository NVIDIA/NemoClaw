// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalEndpoint, type EndpointFlavor } from "../core/url-utils";
import { isBedrockRuntimeEndpoint } from "../inference/bedrock-runtime";
import { isSafeModelId } from "../validation";
import type { GatewayProviderMetadata } from "./gateway-provider-metadata";
import type { RecordedInferenceRoute } from "./provider-recovery";

const MAX_PROVIDER_LENGTH = 128;
const MAX_MODEL_LENGTH = 512;
const SUPPORTED_INFERENCE_APIS_BY_SELECTION: Readonly<Record<string, ReadonlySet<string>>> = {
  openai: new Set(["openai-completions", "openai-responses"]),
  openrouter: new Set(["openai-completions"]),
  gemini: new Set(["openai-completions", "openai-responses"]),
  custom: new Set(["openai-completions", "openai-responses"]),
  anthropic: new Set(["anthropic-messages"]),
  // The Bedrock-compatible adapter can persist its OpenAI-compatible route
  // before the custom-Anthropic selector recognizes it on a later recovery.
  anthropicCompatible: new Set(["anthropic-messages", "openai-completions"]),
};
const SAFE_PROVIDER_NAME = /^[A-Za-z0-9._:-]+$/;

export function isRecoveredProviderCredentialReuseSelectionKey(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_INFERENCE_APIS_BY_SELECTION, value);
}

export type RecoveredProviderReuseDecision =
  | { kind: "validate-host-credential" }
  | { kind: "reuse-gateway-credential"; preferredInferenceApi: string }
  | { kind: "reject"; reason: string };

type EndpointIdentity = {
  flavor: EndpointFlavor;
  routeSource: RecordedInferenceRoute["source"] | null;
  selected: string | null | undefined;
  recovered: string | null | undefined;
  otherRecorded: readonly string[] | null;
};

type RecoveredProviderSelectionState = {
  provider: string;
  endpointUrl: string | null;
  preferredInferenceApi: string | null;
  skipHostInferenceSmoke?: boolean;
  reuseGatewayCredentialWithoutLocalKey?: boolean;
};

type RecoveredProviderSelection = {
  selected: { key: string };
  remoteConfig: { label: string; providerType: string };
  state: RecoveredProviderSelectionState;
  selectedCredentialEnv: string;
  recoveredFromSandbox: boolean;
  selectedModel: string | null;
  sandboxName: string | null;
  recoveredRegistryRoute?: RecordedInferenceRoute | null;
};

type RecoveredProviderSelectionDeps = {
  resolveProviderCredential(name: string): string | null;
  readRecordedInferenceRoute(sandboxName: string | null): RecordedInferenceRoute | null;
  readRecordedProviderEndpoints(
    provider: string,
    excludeSandboxName: string | null,
  ): string[] | null;
  readGatewayProviderMetadata(provider: string): GatewayProviderMetadata | null;
  note(message: string): void;
};

function completeProvider(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 &&
    normalized.length <= MAX_PROVIDER_LENGTH &&
    SAFE_PROVIDER_NAME.test(normalized)
    ? normalized
    : null;
}

function completeModel(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 && normalized.length <= MAX_MODEL_LENGTH && isSafeModelId(normalized)
    ? normalized
    : null;
}

/**
 * Decide whether a non-interactive recovered provider may reuse the credential
 * already held by OpenShell. This boundary never reads the gateway credential:
 * it trusts only the exact registered provider identity plus the persisted
 * routing state needed to re-apply the provider/model route.
 */
export function assessRecoveredProviderCredentialReuse(options: {
  hostCredentialAvailable: boolean;
  recoveredFromSandbox: boolean;
  selectedKey: string;
  selectedProvider: string | null | undefined;
  selectedModel: string | null | undefined;
  recoveredProvider: string | null | undefined;
  recoveredModel: string | null | undefined;
  recoveredPreferredInferenceApi: string | null | undefined;
  expectedProviderType: string;
  expectedCredentialEnv: string;
  gatewayProvider: GatewayProviderMetadata | null;
  endpointIdentity?: EndpointIdentity;
}): RecoveredProviderReuseDecision {
  if (options.hostCredentialAvailable) return { kind: "validate-host-credential" };
  if (!options.recoveredFromSandbox) {
    return { kind: "reject", reason: "the selection was not recovered from this sandbox" };
  }

  const selectedProvider = completeProvider(options.selectedProvider);
  const recoveredProvider = completeProvider(options.recoveredProvider);
  if (!selectedProvider || !recoveredProvider || selectedProvider !== recoveredProvider) {
    return { kind: "reject", reason: "the recovered provider identity is missing or incompatible" };
  }
  const selectedModel = completeModel(options.selectedModel);
  const recoveredModel = completeModel(options.recoveredModel);
  if (!selectedModel || !recoveredModel || selectedModel !== recoveredModel) {
    return { kind: "reject", reason: "the recovered model is missing or invalid" };
  }
  const supportedApis = SUPPORTED_INFERENCE_APIS_BY_SELECTION[options.selectedKey];
  if (!supportedApis?.has(options.recoveredPreferredInferenceApi ?? "")) {
    return { kind: "reject", reason: "the recovered inference API is missing or unsupported" };
  }
  const gatewayProvider = options.gatewayProvider;
  // #6294: an OpenAI-only agent coerced onto openai-completions registers the
  // compatible-anthropic-endpoint provider as type=openai (OPENAI_BASE_URL),
  // so the reuse identity must expect that surface rather than the static
  // anthropic profile. Bedrock endpoints keep their own adapter identity and
  // are excluded so their recovery semantics stay unchanged.
  const expectedProviderType =
    options.selectedKey === "anthropicCompatible" &&
    options.recoveredPreferredInferenceApi === "openai-completions" &&
    !isBedrockRuntimeEndpoint(options.endpointIdentity?.selected ?? null)
      ? "openai"
      : options.expectedProviderType;
  const expectedConfigKey =
    expectedProviderType === "openai"
      ? "OPENAI_BASE_URL"
      : expectedProviderType === "anthropic"
        ? "ANTHROPIC_BASE_URL"
        : null;
  if (
    !gatewayProvider ||
    gatewayProvider.name !== selectedProvider ||
    gatewayProvider.type !== expectedProviderType ||
    gatewayProvider.credentialKeys.length !== 1 ||
    gatewayProvider.credentialKeys[0] !== options.expectedCredentialEnv ||
    !expectedConfigKey ||
    gatewayProvider.configKeys.length !== 1 ||
    gatewayProvider.configKeys[0] !== expectedConfigKey
  ) {
    if (expectedProviderType === "openai" && gatewayProvider?.type === "anthropic") {
      return {
        kind: "reject",
        reason:
          `provider '${selectedProvider}' is still registered for the Anthropic Messages ` +
          `surface; export ${options.expectedCredentialEnv} so onboarding can re-register ` +
          `it for the OpenAI-compatible route`,
      };
    }
    return {
      kind: "reject",
      reason: `provider '${selectedProvider}' has no compatible non-secret identity in OpenShell`,
    };
  }

  if (options.endpointIdentity) {
    // `openshell provider get` intentionally exposes config key names but
    // redacts their values. Without an endpoint value/fingerprint, custom
    // reuse is allowed only from the authoritative registry route, with exact
    // live bindings and no conflicting endpoint recorded for this provider.
    // Canonicalization validates URL structure and removes non-routing detail
    // before either endpoint can participate in an identity comparison.
    const selectedEndpoint = canonicalEndpoint(
      options.endpointIdentity.selected,
      options.endpointIdentity.flavor,
    );
    const recoveredEndpoint = canonicalEndpoint(
      options.endpointIdentity.recovered,
      options.endpointIdentity.flavor,
    );
    const otherEndpoints = options.endpointIdentity.otherRecorded;
    // Every sibling registry row for this globally named provider must resolve
    // to the same endpoint; a missing or divergent row is endpoint drift.
    const allRecordedEndpointsMatch =
      otherEndpoints !== null &&
      otherEndpoints.every(
        (endpoint) =>
          canonicalEndpoint(endpoint, options.endpointIdentity!.flavor) === recoveredEndpoint,
      );
    if (
      !selectedEndpoint ||
      !recoveredEndpoint ||
      selectedEndpoint !== recoveredEndpoint ||
      // Session/live data cannot authorize custom endpoint identity. Only the
      // durable registry route crossed the pre-delete authority boundary.
      options.endpointIdentity.routeSource !== "registry" ||
      !allRecordedEndpointsMatch
    ) {
      return {
        kind: "reject",
        reason: "the recovered endpoint identity is missing or incompatible",
      };
    }
  }

  return {
    kind: "reuse-gateway-credential",
    preferredInferenceApi: options.recoveredPreferredInferenceApi as string,
  };
}

/** Apply the pure reuse decision to the non-interactive onboarding state. */
export function resolveRecoveredProviderCredentialReuse(
  options: RecoveredProviderSelection,
  deps: RecoveredProviderSelectionDeps,
): boolean {
  const { selected, remoteConfig, state, selectedCredentialEnv, recoveredFromSandbox } = options;
  if (deps.resolveProviderCredential(selectedCredentialEnv)) return false;

  const recoveredRoute = recoveredFromSandbox
    ? options.recoveredRegistryRoute?.source === "registry"
      ? options.recoveredRegistryRoute
      : deps.readRecordedInferenceRoute(options.sandboxName)
    : null;
  const customFlavor =
    selected.key === "custom"
      ? "openai"
      : selected.key === "anthropicCompatible"
        ? "anthropic"
        : null;
  const decision = assessRecoveredProviderCredentialReuse({
    hostCredentialAvailable: false,
    recoveredFromSandbox,
    selectedKey: selected.key,
    selectedProvider: state.provider,
    selectedModel: options.selectedModel,
    recoveredProvider: recoveredRoute?.provider,
    recoveredModel: recoveredRoute?.model,
    recoveredPreferredInferenceApi: recoveredRoute?.preferredInferenceApi,
    expectedProviderType: remoteConfig.providerType,
    expectedCredentialEnv: selectedCredentialEnv,
    gatewayProvider: deps.readGatewayProviderMetadata(state.provider),
    endpointIdentity: customFlavor
      ? {
          flavor: customFlavor,
          routeSource: recoveredRoute?.source ?? null,
          selected: state.endpointUrl,
          recovered: recoveredRoute?.endpointUrl,
          otherRecorded: deps.readRecordedProviderEndpoints(state.provider, options.sandboxName),
        }
      : undefined,
  });
  if (decision.kind === "reject") {
    console.error(
      `  Provider credential (or NEMOCLAW_PROVIDER_KEY) is required for ${remoteConfig.label} in non-interactive mode.`,
    );
    console.error(`  Cannot reuse the gateway credential because ${decision.reason}.`);
    process.exit(1);
  }
  if (decision.kind === "validate-host-credential") return false;

  state.skipHostInferenceSmoke = true;
  state.reuseGatewayCredentialWithoutLocalKey = true;
  state.preferredInferenceApi = decision.preferredInferenceApi;
  deps.note(
    `  Reusing existing gateway credential for '${state.provider}'; skipping direct endpoint validation.`,
  );
  return true;
}
