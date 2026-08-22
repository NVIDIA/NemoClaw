// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SetupNimSelectionState } from "../setup-nim-selection";

type RoutedBlueprintProfile = {
  provider_name?: string;
  model: string;
  endpoint?: string;
  credential_env?: string;
  credential_default?: string;
  router?: { enabled?: boolean; credential_env?: string };
};

const EXACT_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function rewriteExactLoopbackEndpoint(endpointUrl: string, hostGatewayUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return endpointUrl;
  }
  if (!EXACT_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return endpointUrl;

  const schemeEnd = endpointUrl.indexOf("://") + 3;
  const authorityEndOffset = endpointUrl.slice(schemeEnd).search(/[/?#]/u);
  const authorityEnd = authorityEndOffset < 0 ? endpointUrl.length : schemeEnd + authorityEndOffset;
  const authority = endpointUrl.slice(schemeEnd, authorityEnd);
  const credentialEnd = authority.lastIndexOf("@") + 1;
  const hostAndPort = authority.slice(credentialEnd);
  const portSeparator = hostAndPort.indexOf(":");
  const hostEnd = hostAndPort.startsWith("[")
    ? hostAndPort.indexOf("]") + 1
    : portSeparator < 0
      ? hostAndPort.length
      : portSeparator;
  const exactHost = hostAndPort.slice(0, hostEnd);
  if (!EXACT_LOOPBACK_HOSTS.has(exactHost.toLowerCase())) return endpointUrl;

  const gatewayHost = new URL(hostGatewayUrl).hostname;
  return `${endpointUrl.slice(0, schemeEnd + credentialEnd)}${gatewayHost}${hostAndPort.slice(hostEnd)}${endpointUrl.slice(authorityEnd)}`;
}

export type RoutedSelectionDeps = {
  loadBlueprintProfile(name: "routed"): RoutedBlueprintProfile | null;
  getHostGatewayUrl(): string;
  defaultCredentialEnv: string;
  isNonInteractive(): boolean;
  exitProcess(code: number): never;
  hydrateCredentialEnv(name: string): string | null;
  normalizeCredentialValue(value: unknown): string;
  saveCredential(name: string, value: string): void;
  resolveRouterProviderKeyBridge(): string | null;
  stageRouterProviderKeyBridge(name: string, resolvedProviderKey: string): void;
  resolveProviderCredential(name: string): string | null;
  ensureNamedCredential(
    name: string | null,
    label: string,
    helpUrl?: string | null,
    validator?: ((value: string) => string | null) | null,
    allowEmpty?: boolean,
    revalidatePolicyRequirements?: (operation: string) => void,
  ): Promise<unknown>;
  returningToProviderSelection(value: unknown): boolean;
  log(message: string): void;
  error(message: string): void;
};

/** Configure the routed selection while keeping every credential mutation receipt-qualified. */
export function createRoutedSelectionHandler(deps: RoutedSelectionDeps) {
  return async function handleRoutedSelection(
    state: SetupNimSelectionState,
  ): Promise<"selected" | "retry-selection"> {
    const profile = deps.loadBlueprintProfile("routed");
    if (!profile || profile.router?.enabled !== true) {
      deps.error("  Router is not enabled in nemoclaw-blueprint/blueprint.yaml.");
      if (deps.isNonInteractive()) deps.exitProcess(1);
      return "retry-selection";
    }

    state.provider = profile.provider_name || "nvidia-router";
    state.model = profile.model;
    state.endpointUrl = profile.endpoint || "";
    if (state.endpointUrl) {
      state.endpointUrl = rewriteExactLoopbackEndpoint(state.endpointUrl, deps.getHostGatewayUrl());
    }
    state.preferredInferenceApi = "openai-completions";
    state.assertRouteCompatible?.();

    const credentialEnv =
      profile.router?.credential_env || profile.credential_env || deps.defaultCredentialEnv;
    state.credentialEnv = credentialEnv;
    const configuredCredential =
      deps.hydrateCredentialEnv(credentialEnv) ||
      deps.normalizeCredentialValue(profile.credential_default || "");
    const resolvedCredential =
      configuredCredential || deps.resolveProviderCredential(credentialEnv);
    const bridgedCredential = resolvedCredential ? null : deps.resolveRouterProviderKeyBridge();
    if (!resolvedCredential && !bridgedCredential) {
      if (deps.isNonInteractive()) {
        deps.error(
          `  ${credentialEnv} (or NEMOCLAW_PROVIDER_KEY) is required for Model Router in non-interactive mode.`,
        );
        deps.exitProcess(1);
      }
      deps.log("");
      deps.log("  Model Router accepts NVIDIA API keys (nvapi-...).");
      deps.log("  Get one at https://build.nvidia.com");
      deps.log("");
      const result = await deps.ensureNamedCredential(
        credentialEnv,
        "Model Router API key",
        null,
        null,
        false,
        state.revalidatePolicyRequirements,
      );
      if (deps.returningToProviderSelection(result)) return "retry-selection";
      if (typeof result !== "string" || !deps.normalizeCredentialValue(result)) {
        deps.error(`  ${credentialEnv} is required for Model Router.`);
        return "retry-selection";
      }
    } else if (configuredCredential) {
      state.revalidatePolicyRequirements?.("save Model Router credential");
      deps.saveCredential(credentialEnv, configuredCredential);
    } else if (bridgedCredential) {
      state.revalidatePolicyRequirements?.("stage Model Router provider credential");
      deps.stageRouterProviderKeyBridge(credentialEnv, bridgedCredential);
    }

    deps.log(`  ✓ Using Model Router: ${state.provider} / ${state.model}`);
    return "selected";
  };
}
