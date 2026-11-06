// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  recordedRegisteredInferenceProviderAttachment,
  verifyRegisteredInferenceProviderAttachment,
} from "../../inference/native-provider/registered";
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
import type { NativeProviderAttachment } from "../../inference/native-provider/contract";
import { fixedNativeProviderForAttachment } from "../../inference/native-provider/fixed";
import { nativeProviderLifecycle } from "../../inference/native-provider";
import { recordedNativeProviderAttachment } from "../../inference/native-provider/recorded-selection";
import type { GatewayProviderMetadata } from "../../onboard/gateway-provider-metadata";
import {
  assessRecoveredProviderCredentialReuse,
  isRecoveredProviderCredentialReuseSelectionKey,
  type RecoveredProviderReuseRejectCondition,
} from "../../onboard/recovered-provider-reuse";
import * as registry from "../../state/registry";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import { isLocalInferenceProvider } from "./rebuild-resume-config";
import {
  normalizeNativeLocalProviderAttachment,
  verifyRecordedNativeLocalProviderAttachment,
} from "../../inference/native-local/profile";

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

/** Recheck the external provider without acquiring ownership of it. */
export async function verifyRebuildRegisteredProviderBeforeDelete(
  sandboxName: string,
  gatewayName: string,
  config: RebuildResumeConfig,
  runtimeSelection?: OpenShellRuntimeSelection,
  getSandbox: (name: string) => RebuildSandboxEntry | null = registry.getSandbox,
): Promise<boolean> {
  try {
    const expected = recordedRegisteredInferenceProviderAttachment({
      ...config,
      name: sandboxName,
      gatewayName,
    });
    const currentMatches = () => {
      const current = getSandbox(sandboxName);
      return (
        current?.agent === config.agent &&
        current.model === config.model &&
        JSON.stringify(recordedRegisteredInferenceProviderAttachment(current)) ===
          JSON.stringify(expected)
      );
    };
    if (
      !expected ||
      (runtimeSelection && runtimeSelection.gatewayName !== gatewayName) ||
      !currentMatches()
    )
      return false;
    await verifyRegisteredInferenceProviderAttachment({
      adapter: rebuildProviderAdapter(runtimeSelection),
      expected,
    });
    return currentMatches();
  } catch {
    return false;
  }
}

/** Revalidate the frozen scoped authority immediately before destructive rebuild work. */
export async function verifyRebuildNativeLocalProviderBeforeDelete(
  sandboxName: string,
  gatewayName: string,
  config: RebuildResumeConfig,
  runtimeSelection?: OpenShellRuntimeSelection,
  getSandbox: (name: string) => RebuildSandboxEntry | null = registry.getSandbox,
): Promise<boolean> {
  try {
    const expected = normalizeNativeLocalProviderAttachment(config.nativeLocalProviderAttachment);
    const currentAuthorityMatches = () => {
      const current = getSandbox(sandboxName);
      return (
        current?.name === sandboxName &&
        current.agent === config.agent &&
        current.provider === config.provider &&
        JSON.stringify(
          normalizeNativeLocalProviderAttachment(current.nativeLocalProviderAttachment),
        ) === JSON.stringify(expected)
      );
    };
    if (
      !expected ||
      (runtimeSelection && runtimeSelection.gatewayName !== gatewayName) ||
      !currentAuthorityMatches()
    )
      return false;
    await verifyRecordedNativeLocalProviderAttachment({
      adapter: rebuildProviderAdapter(runtimeSelection),
      expected,
      sandboxName,
      gatewayName,
      agent: config.agent,
      provider: config.provider,
    });
    return currentAuthorityMatches();
  } catch {
    // Provider diagnostics can include credential material; the caller emits a fixed error.
    return false;
  }
}

export async function inspectRebuildGatewayProviderRegistration(
  provider: string,
  log: (msg: string) => void,
  phase = "Preflight",
  runtimeSelection?: OpenShellRuntimeSelection,
  providerAdapter = rebuildProviderAdapter(runtimeSelection),
  credentialKey?: string | null,
  nativeAttachment?: NativeProviderAttachment,
): Promise<RebuildGatewayProviderRegistration> {
  const safeProvider = providerDiagnosticName(provider);
  const safeCredential = credentialKey ? credentialDiagnosticName(credentialKey) : null;
  let nativeLifecycle: ReturnType<typeof nativeProviderLifecycle> | undefined;
  if (nativeAttachment) {
    try {
      const definition = fixedNativeProviderForAttachment(nativeAttachment);
      if (definition.logicalProvider !== provider) return "indeterminate";
      nativeLifecycle = nativeProviderLifecycle(definition);
    } catch {
      return "indeterminate";
    }
  }
  const result = await providerAdapter.getProvider({
    providerName: nativeAttachment?.providerName ?? provider,
    target: managedProviderGatewayTarget,
    ...(credentialKey ? { includeCredentialExpirations: true } : {}),
  });
  if (result.ok && nativeAttachment) {
    try {
      if (
        nativeLifecycle!.nativeProviderAttachmentFromMetadata(result.value).providerId !==
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
    `${phase} gateway provider check: provider '${safeProvider}' ${
      registration === "registered"
        ? "is registered"
        : registration === "expired"
          ? `has expired credential ${safeCredential}`
          : registration === "credential_missing"
            ? `does not expose credential ${safeCredential}`
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

const PROVIDER_DIAGNOSTIC_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const CREDENTIAL_DIAGNOSTIC_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;

function providerDiagnosticName(value: string): string {
  return PROVIDER_DIAGNOSTIC_NAME.test(value) ? value : "unavailable";
}

function credentialDiagnosticName(value: string): string {
  return CREDENTIAL_DIAGNOSTIC_NAME.test(value) ? value : "unavailable";
}

function printMissingRebuildGatewayProvider(provider: string, credentialEnv: string | null): void {
  const safeProvider = providerDiagnosticName(provider);
  const safeCredential = credentialEnv ? credentialDiagnosticName(credentialEnv) : null;
  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} provider '${safeProvider}' is not registered in OpenShell.`, // lgtm[js/clear-text-logging] Strictly allow-listed provider identifier.
  );
  console.error("  The sandbox registry still points at this upstream provider,");
  console.error("  so rebuild will not recreate it before destroying the sandbox.");
  if (safeCredential) {
    console.error(
      `  Rebuild cannot rely on ${safeCredential} while that provider is missing.`, // lgtm[js/clear-text-logging] Strictly allow-listed environment-variable name.
    );
  }
  console.error("");
  console.error("  Re-register the provider in OpenShell or rerun onboard, then retry rebuild.");
  console.error("  Sandbox is untouched — no data was lost.");
}

function printIndeterminateRebuildGatewayProvider(provider: string): void {
  const safeProvider = providerDiagnosticName(provider);
  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} could not verify provider '${safeProvider}' in OpenShell.`, // lgtm[js/clear-text-logging] Strictly allow-listed provider identifier.
  );
  console.error("  The provider lookup did not return an explicit not-found response.");
  console.error("  Check gateway connectivity and authentication, then retry rebuild.");
  console.error("  Sandbox is untouched — no data was lost.");
}

function printExpiredRebuildGatewayProviderCredential(
  provider: string,
  credentialKey: string,
): void {
  const safeProvider = providerDiagnosticName(provider);
  const safeCredential = credentialDiagnosticName(credentialKey);
  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} provider '${safeProvider}' credential ${safeCredential} is expired in OpenShell.`, // lgtm[js/clear-text-logging] Strictly allow-listed identifiers.
  );
  console.error(
    "  Rebuild will not destroy a sandbox that it cannot restore to working inference.",
  );
  console.error(
    `  Refresh ${safeCredential} in OpenShell or rerun onboard, then retry rebuild.`, // lgtm[js/clear-text-logging] Strictly allow-listed environment-variable name.
  );
  console.error("  Sandbox is untouched — no data was lost.");
}

function printMissingRebuildGatewayProviderCredential(
  provider: string,
  credentialKey: string,
): void {
  const safeProvider = providerDiagnosticName(provider);
  const safeCredential = credentialDiagnosticName(credentialKey);
  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} provider '${safeProvider}' no longer exposes credential ${safeCredential}.`, // lgtm[js/clear-text-logging] Strictly allow-listed identifiers.
  );
  console.error(
    "  Rebuild will not destroy a sandbox that it cannot restore to working inference.",
  );
  console.error(
    `  Re-register '${safeProvider}' with ${safeCredential} in OpenShell or rerun onboard, then retry rebuild.`, // lgtm[js/clear-text-logging] Strictly allow-listed identifiers.
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
    nativeAttachment?: NativeProviderAttachment;
    allowProviderReconfigure?: boolean;
    hostCredentialAvailable?: boolean;
    onProviderReconfigureRequired?: (provider: string, credentialEnv: string) => void;
  } = {},
): Promise<boolean> {
  if (!options.nativeAttachment && !shouldVerifyRebuildGatewayProvider(provider)) return true;
  if (!provider) return false;
  const safeProvider = providerDiagnosticName(provider);
  const safeCredential = credentialEnv ? credentialDiagnosticName(credentialEnv) : null;

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
    bail(`Expired gateway provider credential: ${safeProvider}/${safeCredential}`);
    return false;
  }
  if (registration === "credential_missing" && credentialEnv) {
    printMissingRebuildGatewayProviderCredential(provider, credentialEnv);
    bail(`Missing gateway provider credential: ${safeProvider}/${safeCredential}`);
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
      `Preflight gateway provider check: validated prepared recovery will recreate missing provider '${safeProvider}' from ${safeCredential}`,
    );
    return true;
  }

  if (registration === "indeterminate") {
    printIndeterminateRebuildGatewayProvider(provider);
    bail(`Could not verify gateway provider: ${safeProvider}`);
    return false;
  }

  printMissingRebuildGatewayProvider(provider, credentialEnv);
  bail(`Missing gateway provider: ${safeProvider}`);
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
  if (config.registeredInferenceProviderAttachment !== undefined) {
    const expected = config.registeredInferenceProviderAttachment;
    if (
      await verifyRebuildRegisteredProviderBeforeDelete(sandboxName, expected.gatewayName, config)
    )
      return true;
    bail("Could not verify registered provider credential reuse; sandbox is untouched");
    return false;
  }
  if (config.nativeLocalProviderAttachment !== undefined) {
    try {
      await verifyRecordedNativeLocalProviderAttachment({
        adapter: rebuildProviderAdapter(),
        expected: config.nativeLocalProviderAttachment,
        sandboxName,
        agent: config.agent,
        provider: config.provider,
      });
      return true;
    } catch {
      bail("Could not verify native local provider credential reuse; sandbox is untouched");
      return false;
    }
  }
  const nativeAttachment = recordedNativeProviderAttachment(config);
  if (nativeAttachment) {
    return checkRebuildGatewayProviderOrBail(config.provider, config.credentialEnv, log, bail, {
      nativeAttachment,
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
  console.error(
    `  ${rebuildCredentialReuseCondition(
      decision.kind === "reject" ? decision.condition : "gateway-provider-identity",
    )}`,
  );
  console.error("  Export the provider credential to use normal validation and upsert.");
  console.error("  Sandbox is untouched — no data was lost.");
  bail("Unsafe gateway credential reuse");
  return false;
}
