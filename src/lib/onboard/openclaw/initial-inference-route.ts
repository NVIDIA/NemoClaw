// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxInferenceConfig } from "../../inference/config";
import type { ConfigObject } from "../../security/credential-filter";

const initialOpenclawInferenceRouteRuntime = {
  loadInferenceSet: () =>
    require("../../actions/inference-set") as typeof import("../../actions/inference-set"),
  loadSandboxConfig: () => require("../../sandbox/config") as typeof import("../../sandbox/config"),
  loadFinalizationDeps: () =>
    require("../machine/finalization-deps") as typeof import("../machine/finalization-deps"),
};

export interface InitialOpenclawInferenceRouteDeps {
  readOpenclawConfig(sandboxName: string): ConfigObject;
  patchOpenclawInferenceConfig(
    config: ConfigObject,
    provider: string,
    model: string,
    preferredInferenceApi: string | null,
    contextWindow: undefined,
    upstreamProviderMarker: string,
  ): { route: SandboxInferenceConfig };
  writeOpenclawInferenceConfigNatively(
    sandboxName: string,
    config: ConfigObject,
    route: SandboxInferenceConfig,
  ): void;
  restartNativeGateway(sandboxName: string): Promise<
    | { ok: true }
    | {
        ok: false;
        failureLayer: string;
        detail: string;
      }
  >;
}

export type InitializeOpenclawInferenceRoute = (
  sandboxName: string,
  model: string,
  provider: string,
  preferredInferenceApi: string | null,
  revalidateSandboxIdentity?: (operation: string) => void,
) => Promise<void>;

export function createInitialOpenclawInferenceRoute(
  deps: InitialOpenclawInferenceRouteDeps,
): InitializeOpenclawInferenceRoute {
  return async function initializeOpenclawInferenceRoute(
    sandboxName,
    model,
    provider,
    preferredInferenceApi,
    revalidateSandboxIdentity,
  ): Promise<void> {
    revalidateSandboxIdentity?.(`read native OpenClaw config in sandbox '${sandboxName}'`);
    const config = deps.readOpenclawConfig(sandboxName);
    const patched = deps.patchOpenclawInferenceConfig(
      config,
      provider,
      model,
      preferredInferenceApi,
      undefined,
      provider,
    );

    revalidateSandboxIdentity?.(
      `apply native OpenClaw inference route in sandbox '${sandboxName}'`,
    );
    deps.writeOpenclawInferenceConfigNatively(sandboxName, config, patched.route);

    revalidateSandboxIdentity?.(`restart native OpenClaw gateway in sandbox '${sandboxName}'`);
    const restart = await deps.restartNativeGateway(sandboxName);
    if (!restart.ok) {
      throw new Error(
        `OpenClaw native gateway restart failed after initial inference configuration (${restart.failureLayer}): ${restart.detail}`,
      );
    }
  };
}

export const initializeOpenclawInferenceRoute = createInitialOpenclawInferenceRoute({
  readOpenclawConfig: (sandboxName) => {
    const config = initialOpenclawInferenceRouteRuntime.loadSandboxConfig();
    return config.readSandboxConfig(sandboxName, config.resolveAgentConfig(sandboxName));
  },
  patchOpenclawInferenceConfig: (...args) =>
    initialOpenclawInferenceRouteRuntime.loadInferenceSet().patchOpenClawInferenceConfig(...args),
  writeOpenclawInferenceConfigNatively: (sandboxName, config, route) => {
    const inferenceSet = initialOpenclawInferenceRouteRuntime.loadInferenceSet();
    // Final onboarding selects its attempt-scoped gateway before this step, so
    // the native config command uses that selected OpenShell runtime.
    inferenceSet.writeOpenClawInferenceConfigNatively(
      sandboxName,
      config,
      route,
      initialOpenclawInferenceRouteRuntime.loadSandboxConfig().setOpenClawConfigValues,
    );
  },
  restartNativeGateway: (sandboxName) =>
    initialOpenclawInferenceRouteRuntime
      .loadFinalizationDeps()
      .restartNativeGatewayForInitialSetup(sandboxName),
});
