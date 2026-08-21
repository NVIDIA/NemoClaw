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

export type RoutedSelectionDeps = {
  loadBlueprintProfile(name: "routed"): RoutedBlueprintProfile | null;
  getHostGatewayUrl(): string;
  defaultCredentialEnv: string;
  isNonInteractive(): boolean;
  exitProcess(code: number): never;
  hydrateCredentialEnv(name: string): string | null;
  normalizeCredentialValue(value: unknown): string;
  saveCredential(name: string, value: string): void;
  stageRouterProviderKeyBridge(name: string): void;
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
    const endpointUrl = profile.endpoint || "";
    state.endpointUrl = endpointUrl;
    if (endpointUrl.match(/localhost|127\.0\.0\.1/u)) {
      const url = new URL(endpointUrl);
      state.endpointUrl = `${deps.getHostGatewayUrl()}:${url.port}${url.pathname}`;
    }
    state.preferredInferenceApi = "openai-completions";
    state.assertRouteCompatible?.();

    const credentialEnv =
      profile.router?.credential_env || profile.credential_env || deps.defaultCredentialEnv;
    state.credentialEnv = credentialEnv;
    const credential =
      deps.hydrateCredentialEnv(credentialEnv) ||
      deps.normalizeCredentialValue(profile.credential_default || "");
    if (credential) {
      state.revalidatePolicyRequirements?.("save Model Router credential");
      deps.saveCredential(credentialEnv, credential);
    }
    state.revalidatePolicyRequirements?.("stage Model Router provider credential");
    deps.stageRouterProviderKeyBridge(credentialEnv);
    if (deps.isNonInteractive()) {
      if (!deps.resolveProviderCredential(credentialEnv)) {
        deps.error(
          `  ${credentialEnv} (or NEMOCLAW_PROVIDER_KEY) is required for Model Router in non-interactive mode.`,
        );
        deps.exitProcess(1);
      }
    } else if (!deps.resolveProviderCredential(credentialEnv)) {
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
    }

    deps.log(`  ✓ Using Model Router: ${state.provider} / ${state.model}`);
    return "selected";
  };
}
