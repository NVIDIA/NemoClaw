// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateNvidiaApiKeyValue } from "../../credentials/api-key-validation";
import { getCompatibleAnthropicOpenAiSurfaceBaseUrl } from "../../inference/anthropic/openai-surface";
import {
  assertEndpointResolvesPublic,
  parseTrustedPrivateInferenceHostsFromEnv,
} from "../../inference/endpoint-ssrf-preflight";
import { usesNvidiaEndpointProbePayload } from "../../inference/openai-probe-models";
import { getRemoteProviderConfigForName } from "../../onboard/inference-providers/provider-selection-keys";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";

import {
  createManagedProviderAdapter,
  managedProviderGatewayTarget,
} from "../../adapters/openshell/managed-provider-adapter";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { RunProviderCommand } from "../../adapters/openshell/provider-adapter-cli";
import { runOpenshellProviderCommand } from "../../adapters/openshell/provider-command";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { RD as _RD, R } from "../../cli/terminal-style";
import {
  hasBedrockRuntimeAwsAuthEnv,
  isBedrockRuntimeEndpoint,
} from "../../inference/bedrock-runtime";
import {
  isNativeNvidiaProvider,
  nativeNvidiaProviderAttachmentFromMetadata,
  type NativeNvidiaProviderAttachment,
} from "../../inference/native-nvidia";
import type { GatewayProviderMetadata } from "../../onboard/gateway-provider-metadata";
import {
  assessRecoveredProviderCredentialReuse,
  isRecoveredProviderCredentialReuseSelectionKey,
  type RecoveredProviderReuseRejectCondition,
} from "../../onboard/recovered-provider-reuse";
import * as registry from "../../state/registry";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import { isLocalInferenceProvider } from "./rebuild-resume-config";

const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
};
const { REMOTE_PROVIDER_CONFIG } = require("../../onboard/providers") as {
  REMOTE_PROVIDER_CONFIG: Record<
    string,
    {
      providerName: string;
      providerType: string;
      endpointUrl: string;
      credentialEnv: string | null;
    }
  >;
};

type ProbeResult = { ok: boolean; validated?: boolean };
type Probe = (
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: Record<string, unknown>,
) => ProbeResult | Promise<ProbeResult>;

const probes = require("../../inference/onboard-probes") as {
  probeAnthropicEndpoint: Probe;
  probeOpenAiLikeEndpointOptimized: Probe;
  getProbeExtraHeaders(provider: string): string[] | undefined;
};

export type HostCredentialTarget = Pick<
  RebuildSandboxEntry,
  "provider" | "model" | "endpointUrl" | "credentialEnv" | "preferredInferenceApi"
>;

/** Validate the host credential that recreate can submit, without changing the gateway. */
export async function validateRebuildHostInferenceCredential(
  target: HostCredentialTarget,
  credentialValue: string,
  deps = {
    assertEndpointResolvesPublic,
    probeAnthropicEndpoint: probes.probeAnthropicEndpoint,
    probeOpenAiLikeEndpointOptimized: probes.probeOpenAiLikeEndpointOptimized,
  },
): Promise<boolean> {
  const config = getRemoteProviderConfigForName(target.provider, REMOTE_PROVIDER_CONFIG);
  // Local, routed, and Hermes authentication retain their existing preflights.
  if (!config || config.providerName === "llama-cpp-local" || target.provider === "hermes-provider")
    return true;
  if (
    target.provider === "compatible-anthropic-endpoint" &&
    isBedrockRuntimeEndpoint(target.endpointUrl)
  ) {
    return true;
  }
  if (validateNvidiaApiKeyValue(credentialValue, target.credentialEnv ?? "")) return false;
  let endpointUrl = config.endpointUrl || target.endpointUrl;
  if (!endpointUrl || !target.model) return false;

  try {
    const pins = !config.endpointUrl
      ? await deps.assertEndpointResolvesPublic(endpointUrl, undefined, {
          trustedPrivateHosts: parseTrustedPrivateInferenceHostsFromEnv(process.env),
        })
      : null;
    if (pins && !pins.ok) return false;
    const useAnthropic =
      config.providerType === "anthropic" && target.preferredInferenceApi !== "openai-completions";
    if (config.providerType === "anthropic" && !useAnthropic) {
      endpointUrl = getCompatibleAnthropicOpenAiSurfaceBaseUrl(endpointUrl);
    }
    const probe = useAnthropic
      ? deps.probeAnthropicEndpoint
      : deps.probeOpenAiLikeEndpointOptimized;
    const result = await probe(endpointUrl, target.model, credentialValue, {
      skipResponsesProbe: target.preferredInferenceApi !== "openai-responses",
      probeStreaming: false,
      provider: target.provider,
      extraHeaders: probes.getProbeExtraHeaders(target.provider ?? ""),
      useNvidiaEndpointProbePayload: usesNvidiaEndpointProbePayload(target.provider ?? ""),
      ...(pins?.ok
        ? {
            pinnedAddresses: pins.addresses,
            trustedPrivateCapability: pins.trustedPrivateCapability,
          }
        : {}),
    });
    return result.ok && result.validated !== false;
  } catch {
    // Probe errors and response bodies can contain credentials.
    return false;
  }
}

export type RebuildGatewayProviderRegistration =
  | "registered"
  | "expired"
  | "credential_missing"
  | "missing"
  | "indeterminate";

function rebuildProviderAdapter(
  runtimeSelection?: OpenShellRuntimeSelection,
): OpenShellProviderAdapter {
  return createManagedProviderAdapter(
    runtimeSelection
      ? (((args, options) =>
          runOpenshellProviderCommand(args, {
            ...options,
            runtimeSelection,
          })) as RunProviderCommand)
      : undefined,
  );
}

export async function inspectRebuildGatewayProviderRegistration(
  provider: string,
  log: (msg: string) => void,
  phase = "Preflight",
  runtimeSelection?: OpenShellRuntimeSelection,
  providerAdapter = rebuildProviderAdapter(runtimeSelection),
  credentialKey?: string | null,
  nativeAttachment?: NativeNvidiaProviderAttachment,
): Promise<RebuildGatewayProviderRegistration> {
  if (nativeAttachment && !isNativeNvidiaProvider(provider)) return "indeterminate";
  const result = await providerAdapter.getProvider({
    providerName: nativeAttachment?.providerName ?? provider,
    target: managedProviderGatewayTarget,
    ...(credentialKey ? { includeCredentialExpirations: true } : {}),
  });
  if (result.ok && nativeAttachment) {
    try {
      if (
        nativeNvidiaProviderAttachmentFromMetadata(result.value).providerId !==
        nativeAttachment.providerId
      )
        return "indeterminate";
    } catch {
      return "indeterminate";
    }
  }
  const expiresAtMs = result.ok && credentialKey ? result.value.credentialExpiresAtMs : undefined;
  const credentialExpiresAtMs = credentialKey ? expiresAtMs?.[credentialKey] : undefined;
  const credentialKeyMissing = Boolean(
    result.ok && credentialKey && !result.value.credentialKeys.includes(credentialKey),
  );
  const registration = result.ok
    ? credentialKey && expiresAtMs === undefined
      ? "indeterminate"
      : credentialKeyMissing
        ? "credential_missing"
        : credentialExpiresAtMs !== undefined &&
            credentialExpiresAtMs > 0 &&
            credentialExpiresAtMs <= Date.now()
          ? "expired"
          : "registered"
    : result.error.kind === "command" && result.error.reason === "not_found"
      ? "missing"
      : "indeterminate";
  log(
    `${phase} gateway provider check: provider '${provider}' ${
      registration === "registered"
        ? "is registered"
        : registration === "expired"
          ? `has expired credential ${credentialKey}`
          : registration === "credential_missing"
            ? `does not expose credential ${credentialKey}`
            : registration === "missing"
              ? "is explicitly missing"
              : "could not be verified"
    } in OpenShell`,
  );
  return registration;
}

type GatewayCredentialReusePreflightDeps = {
  hasBedrockRuntimeAwsAuth?(): boolean;
  readGatewayProviderMetadata(provider: string): Promise<GatewayProviderMetadata | null>;
  readRecordedProviderEndpoints(provider: string, excludeSandboxName: string): string[] | null;
};

function rebuildCredentialReuseCondition(condition: RecoveredProviderReuseRejectCondition): string {
  switch (condition) {
    case "recovery-source":
      return "The provider selection was not recovered from this sandbox.";
    case "provider-identity":
      return "The recorded provider identity is missing or incompatible.";
    case "model-identity":
      return "The recorded model identity is missing or invalid.";
    case "inference-api":
      return "The recorded inference API is missing or unsupported.";
    case "provider-surface":
      return "The gateway provider is registered for a different API surface.";
    case "gateway-provider-identity":
      return "The gateway provider binding is missing or incompatible.";
    case "endpoint-identity":
      return "The recorded endpoint identity is missing or incompatible.";
  }
}

function printMissingRebuildGatewayProvider(provider: string, credentialEnv: string | null): void {
  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} provider '${provider}' is not registered in OpenShell.`,
  );
  console.error("  The sandbox registry still points at this upstream provider,");
  console.error("  so rebuild will not recreate it before destroying the sandbox.");
  if (credentialEnv) {
    console.error(`  Rebuild cannot rely on ${credentialEnv} while that provider is missing.`);
  }
  console.error("");
  console.error("  Re-register the provider in OpenShell or rerun onboard, then retry rebuild.");
  console.error("  Sandbox is untouched — no data was lost.");
}

function printIndeterminateRebuildGatewayProvider(provider: string): void {
  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} could not verify provider '${provider}' in OpenShell.`,
  );
  console.error("  The provider lookup did not return an explicit not-found response.");
  console.error("  Check gateway connectivity and authentication, then retry rebuild.");
  console.error("  Sandbox is untouched — no data was lost.");
}

function printExpiredRebuildGatewayProviderCredential(
  provider: string,
  credentialKey: string,
): void {
  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} provider '${provider}' credential ${credentialKey} is expired in OpenShell.`,
  );
  console.error(
    "  Rebuild will not destroy a sandbox that it cannot restore to working inference.",
  );
  console.error(`  Refresh ${credentialKey} in OpenShell or rerun onboard, then retry rebuild.`);
  console.error("  Sandbox is untouched — no data was lost.");
}

function printMissingRebuildGatewayProviderCredential(
  provider: string,
  credentialKey: string,
): void {
  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} provider '${provider}' no longer exposes credential ${credentialKey}.`,
  );
  console.error(
    "  Rebuild will not destroy a sandbox that it cannot restore to working inference.",
  );
  console.error(
    `  Re-register '${provider}' with ${credentialKey} in OpenShell or rerun onboard, then retry rebuild.`,
  );
  console.error("  Sandbox is untouched — no data was lost.");
}

export function shouldVerifyRebuildGatewayProvider(
  provider: string | null | undefined,
): provider is string {
  // Remote registrations can hold the only copy of a provider credential, so
  // their absence is unrecoverable. Local registrations are reconstructible:
  // rebuild resume rewinds provider selection/inference and those setup paths
  // upsert the local provider with locally available credentials.
  return Boolean(
    provider &&
    !isLocalInferenceProvider(provider) &&
    provider !== hermesProviderAuth.HERMES_PROVIDER_NAME,
  );
}

/** Whether authoritative resume can recreate this exact provider/credential binding. */
export function canRecreateMissingRebuildGatewayProvider(
  provider: string | null | undefined,
  credentialEnv: string | null,
): boolean {
  if (!provider || !credentialEnv) return false;
  const config =
    provider === "nvidia-nim"
      ? REMOTE_PROVIDER_CONFIG.build
      : Object.values(REMOTE_PROVIDER_CONFIG).find((entry) => entry.providerName === provider);
  return config?.credentialEnv === credentialEnv;
}

export async function checkRebuildGatewayProviderOrBail(
  provider: string | null | undefined,
  credentialEnv: string | null,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
  options: {
    nativeAttachment?: NativeNvidiaProviderAttachment;
    allowProviderReconfigure?: boolean;
    hostCredentialAvailable?: boolean;
    onProviderReconfigureRequired?: (provider: string, credentialEnv: string) => void;
  } = {},
): Promise<boolean> {
  if (!shouldVerifyRebuildGatewayProvider(provider)) return true;

  const registration = await inspectRebuildGatewayProviderRegistration(
    provider,
    log,
    "Preflight",
    undefined,
    rebuildProviderAdapter(),
    credentialEnv,
    options.nativeAttachment,
  );
  if (registration === "registered") return true;
  if (registration === "expired" && credentialEnv) {
    printExpiredRebuildGatewayProviderCredential(provider, credentialEnv);
    bail(`Expired gateway provider credential: ${provider}/${credentialEnv}`);
    return false;
  }
  if (registration === "credential_missing" && credentialEnv) {
    printMissingRebuildGatewayProviderCredential(provider, credentialEnv);
    bail(`Missing gateway provider credential: ${provider}/${credentialEnv}`);
    return false;
  }
  if (
    registration === "missing" &&
    !options.nativeAttachment &&
    options.allowProviderReconfigure &&
    options.hostCredentialAvailable &&
    credentialEnv &&
    canRecreateMissingRebuildGatewayProvider(provider, credentialEnv)
  ) {
    options.onProviderReconfigureRequired?.(provider, credentialEnv);
    log(
      `Preflight gateway provider check: validated prepared recovery will recreate missing provider '${provider}' from ${credentialEnv}`,
    );
    return true;
  }

  if (registration === "indeterminate") {
    printIndeterminateRebuildGatewayProvider(provider);
    bail(`Could not verify gateway provider: ${provider}`);
    return false;
  }

  printMissingRebuildGatewayProvider(provider, credentialEnv);
  bail(`Missing gateway provider: ${provider}`);
  return false;
}

function defaultGatewayCredentialReusePreflightDeps(): GatewayCredentialReusePreflightDeps {
  const providerAdapter = rebuildProviderAdapter();
  return {
    readGatewayProviderMetadata: async (provider) => {
      const result = await providerAdapter.getProvider({
        providerName: provider,
        target: managedProviderGatewayTarget,
      });
      return result.ok ? result.value : null;
    },
    readRecordedProviderEndpoints: (provider, excludeSandboxName) => {
      try {
        return registry
          .listSandboxes()
          .sandboxes.filter(
            (entry) => entry.name !== excludeSandboxName && entry.provider === provider,
          )
          .map((entry) => (typeof entry.endpointUrl === "string" ? entry.endpointUrl.trim() : ""));
      } catch {
        return null;
      }
    },
  };
}

/** Validate keyless gateway-provider reuse before a rebuild deletes the sandbox. */
export async function checkRebuildGatewayCredentialReuseOrBail(
  sandboxName: string,
  config: RebuildResumeConfig,
  hostCredentialAvailable: boolean,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
  deps: GatewayCredentialReusePreflightDeps = defaultGatewayCredentialReusePreflightDeps(),
): Promise<boolean> {
  if (config.nativeNvidiaProviderAttachment) {
    return checkRebuildGatewayProviderOrBail(config.provider, config.credentialEnv, log, bail, {
      nativeAttachment: config.nativeNvidiaProviderAttachment,
    });
  }
  if (hostCredentialAvailable || !config.provider || !config.credentialEnv) return true;
  const isBedrockRuntime =
    config.provider === "compatible-anthropic-endpoint" &&
    isBedrockRuntimeEndpoint(config.endpointUrl);
  if (isBedrockRuntime) {
    if ((deps.hasBedrockRuntimeAwsAuth ?? hasBedrockRuntimeAwsAuthEnv)()) {
      log("Preflight Bedrock Runtime authentication: explicit AWS auth source is available");
      return true;
    }
    console.error("");
    console.error(`  ${_RD}Rebuild preflight failed:${R} Bedrock Runtime auth is unavailable.`);
    console.error(
      "  Export AWS_BEARER_TOKEN_BEDROCK, AWS_PROFILE, IAM environment credentials, or COMPATIBLE_ANTHROPIC_API_KEY.",
    );
    console.error("  Sandbox is untouched — no data was lost.");
    bail("Missing Bedrock Runtime authentication");
    return false;
  }

  const selected = Object.entries(REMOTE_PROVIDER_CONFIG).find(
    ([key, remote]) =>
      isRecoveredProviderCredentialReuseSelectionKey(key) &&
      remote.providerName === config.provider,
  );
  if (!selected) return true;

  const [selectedKey, remoteConfig] = selected;
  const route = config.registryInferenceRoute;
  const endpointFlavor =
    selectedKey === "custom"
      ? "openai"
      : selectedKey === "anthropicCompatible"
        ? "anthropic"
        : null;
  const decision = assessRecoveredProviderCredentialReuse({
    hostCredentialAvailable: false,
    recoveredFromSandbox: true,
    selectedKey,
    selectedProvider: config.provider,
    selectedModel: config.model,
    recoveredProvider: route?.provider,
    recoveredModel: route?.model,
    recoveredPreferredInferenceApi: route?.preferredInferenceApi,
    expectedProviderType: remoteConfig.providerType,
    expectedCredentialEnv: config.credentialEnv,
    gatewayProvider: await deps.readGatewayProviderMetadata(config.provider),
    endpointIdentity: endpointFlavor
      ? {
          flavor: endpointFlavor,
          routeSource: route?.source ?? null,
          selected: config.endpointUrl,
          recovered: route?.endpointUrl,
          otherRecorded: deps.readRecordedProviderEndpoints(config.provider, sandboxName),
        }
      : undefined,
  });
  if (decision.kind === "reuse-gateway-credential") {
    log(
      `Preflight gateway credential reuse: validated provider '${config.provider}' and its recorded route`,
    );
    return true;
  }
  if (decision.kind === "validate-host-credential") return true;
  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} cannot safely reuse the recorded gateway credential.`,
  );
  console.error(`  ${rebuildCredentialReuseCondition(decision.condition)}`);
  console.error("  Export the provider credential to use normal validation and upsert.");
  console.error("  Sandbox is untouched — no data was lost.");
  bail("Unsafe gateway credential reuse");
  return false;
}
