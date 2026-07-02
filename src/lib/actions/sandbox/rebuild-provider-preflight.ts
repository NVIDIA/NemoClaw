// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { RD as _RD, R } from "../../cli/terminal-style";
import {
  hasBedrockRuntimeAwsAuthEnv,
  isBedrockRuntimeEndpoint,
} from "../../inference/bedrock-runtime";
import type { GatewayProviderMetadata } from "../../onboard/gateway-provider-metadata";
import {
  assessRecoveredProviderCredentialReuse,
  isRecoveredProviderCredentialReuseSelectionKey,
} from "../../onboard/recovered-provider-reuse";
import * as registry from "../../state/registry";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import { isLocalInferenceProvider } from "./rebuild-resume-config";

const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
};
const { providerExistsInGateway, readGatewayProviderMetadata, REMOTE_PROVIDER_CONFIG } =
  require("../../onboard/providers") as {
    providerExistsInGateway: (name: string, runOpenshellFn: typeof runOpenshell) => boolean;
    readGatewayProviderMetadata: (
      name: string,
      runOpenshellFn: typeof runOpenshell,
    ) => GatewayProviderMetadata | null;
    REMOTE_PROVIDER_CONFIG: Record<
      string,
      {
        providerName: string;
        providerType: string;
        credentialEnv: string | null;
      }
    >;
  };

type GatewayCredentialReusePreflightDeps = {
  hasBedrockRuntimeAwsAuth?(): boolean;
  readGatewayProviderMetadata(provider: string): GatewayProviderMetadata | null;
  readRecordedProviderEndpoints(provider: string, excludeSandboxName: string): string[] | null;
};

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

export function checkRebuildGatewayProviderOrBail(
  provider: string | null | undefined,
  credentialEnv: string | null,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
): boolean {
  if (!shouldVerifyRebuildGatewayProvider(provider)) return true;

  const providerRegisteredInGateway = providerExistsInGateway(provider, runOpenshell);
  log(
    `Preflight gateway provider check: provider '${provider}' is ${
      providerRegisteredInGateway ? "registered" : "missing"
    } in OpenShell`,
  );
  if (providerRegisteredInGateway) return true;

  printMissingRebuildGatewayProvider(provider, credentialEnv);
  bail(`Missing gateway provider: ${provider}`);
  return false;
}

function defaultGatewayCredentialReusePreflightDeps(): GatewayCredentialReusePreflightDeps {
  return {
    readGatewayProviderMetadata: (provider) => readGatewayProviderMetadata(provider, runOpenshell),
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
export function checkRebuildGatewayCredentialReuseOrBail(
  sandboxName: string,
  config: RebuildResumeConfig,
  hostCredentialAvailable: boolean,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
  deps: GatewayCredentialReusePreflightDeps = defaultGatewayCredentialReusePreflightDeps(),
): boolean {
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
    gatewayProvider: deps.readGatewayProviderMetadata(config.provider),
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
  const rejectionReason =
    decision.kind === "reject"
      ? decision.reason
      : "the host credential state changed during preflight";

  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} cannot safely reuse the gateway credential for '${config.provider}'.`,
  );
  console.error(`  ${rejectionReason}.`);
  console.error(`  Export ${config.credentialEnv} to use normal credential validation and upsert.`);
  console.error("  Sandbox is untouched — no data was lost.");
  bail(`Unsafe gateway credential reuse for provider '${config.provider}': ${rejectionReason}`);
  return false;
}
