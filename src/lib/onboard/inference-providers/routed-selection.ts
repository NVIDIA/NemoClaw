// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SetupNimSelectionState } from "../setup-nim-selection";

type RoutedSelectionDeps = {
  modelRouter: {
    readonly DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV: string;
    loadBlueprintProfile(name: "routed"): {
      provider_name?: string;
      endpoint?: string;
      model: string;
      credential_env?: string;
      credential_default?: string;
      router: { enabled?: boolean; credential_env?: string };
    } | null;
  };
  localInference: { readonly HOST_GATEWAY_URL: string };
  urlUtils: { isLoopbackHostname(hostname: string): boolean };
  credentials: {
    normalizeCredentialValue(value: unknown): string;
    resolveProviderCredential(name: string): string | null;
    saveCredential(name: string, value: string): void;
  };
  hydrateCredentialEnv(name: string): string | null;
  providerKeyBridge: {
    resolveRouterProviderKeyBridge(): string | null;
    stageRouterProviderKeyBridge(name: string, value: string): void;
  };
  isNonInteractive(): boolean;
  exitProcess(code: number): never;
  credentialPrompt: {
    ensureNamedCredential(
      name: string | null,
      label: string,
      helpUrl?: string | null,
      validator?: ((value: string) => string | null) | null,
      allowEmpty?: boolean,
      revalidateSandboxIdentity?: (operation: string) => void,
    ): Promise<unknown>;
    returningToProviderSelection(value: unknown): boolean;
  };
};

function isExactLoopbackHost(hostname: string, deps: RoutedSelectionDeps): boolean {
  const normalized = hostname.toLowerCase();
  return (
    deps.urlUtils.isLoopbackHostname(normalized) &&
    (normalized === "localhost" ||
      normalized === "127.0.0.1" ||
      normalized === "::1" ||
      normalized === "[::1]")
  );
}

function rewriteLoopbackEndpoint(endpointUrl: string, deps: RoutedSelectionDeps): string {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return endpointUrl;
  }
  if (!isExactLoopbackHost(parsed.hostname, deps)) return endpointUrl;

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
  if (!isExactLoopbackHost(hostAndPort.slice(0, hostEnd), deps)) return endpointUrl;

  const gatewayHost = new URL(deps.localInference.HOST_GATEWAY_URL).hostname;
  return `${endpointUrl.slice(0, schemeEnd + credentialEnd)}${gatewayHost}${hostAndPort.slice(hostEnd)}${endpointUrl.slice(authorityEnd)}`;
}

/** Select the built-in Model Router while guarding each credential mutation. */
export async function handleRoutedSelection(
  state: SetupNimSelectionState,
  deps: RoutedSelectionDeps,
): Promise<"selected" | "retry-selection"> {
  const profile = deps.modelRouter.loadBlueprintProfile("routed");
  if (!profile || profile.router.enabled !== true) {
    console.error("  Router is not enabled in nemoclaw-blueprint/blueprint.yaml.");
    if (deps.isNonInteractive()) deps.exitProcess(1);
    return "retry-selection";
  }

  state.provider = profile.provider_name || "nvidia-router";
  state.model = profile.model;
  state.endpointUrl = profile.endpoint ? rewriteLoopbackEndpoint(profile.endpoint, deps) : "";
  state.preferredInferenceApi = "openai-completions";
  state.assertRouteCompatible?.();

  const credentialEnv =
    profile.router.credential_env ||
    profile.credential_env ||
    deps.modelRouter.DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV;
  state.credentialEnv = credentialEnv;
  const configuredCredential =
    deps.hydrateCredentialEnv(credentialEnv) ||
    deps.credentials.normalizeCredentialValue(profile.credential_default || "");
  const resolvedCredential =
    configuredCredential || deps.credentials.resolveProviderCredential(credentialEnv);
  const bridgedCredential = resolvedCredential
    ? null
    : deps.providerKeyBridge.resolveRouterProviderKeyBridge();
  if (!resolvedCredential && !bridgedCredential) {
    if (deps.isNonInteractive()) {
      console.error(
        `  ${credentialEnv} (or NEMOCLAW_PROVIDER_KEY) is required for Model Router in non-interactive mode.`,
      );
      deps.exitProcess(1);
    }
    console.log("");
    console.log("  Model Router accepts NVIDIA API keys (nvapi-...).");
    console.log("  Get one at https://build.nvidia.com");
    console.log("");
    const result = await deps.credentialPrompt.ensureNamedCredential(
      credentialEnv,
      "Model Router API key",
      null,
      null,
      false,
      state.revalidateSandboxIdentity,
    );
    if (deps.credentialPrompt.returningToProviderSelection(result)) return "retry-selection";
    if (typeof result !== "string" || !deps.credentials.normalizeCredentialValue(result)) {
      console.error(`  ${credentialEnv} is required for Model Router.`);
      return "retry-selection";
    }
  } else if (configuredCredential) {
    state.revalidateSandboxIdentity?.("save Model Router credential");
    deps.credentials.saveCredential(credentialEnv, configuredCredential);
  } else if (bridgedCredential) {
    state.revalidateSandboxIdentity?.("stage Model Router provider credential");
    deps.providerKeyBridge.stageRouterProviderKeyBridge(credentialEnv, bridgedCredential);
  }

  console.log(`  ✓ Using Model Router: ${state.provider} / ${state.model}`);
  return "selected";
}
