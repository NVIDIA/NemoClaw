// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxInferenceConfig } from "../../inference/config";
import type { ReasoningEffortRequest } from "../../inference/selection";
import type { ConfigObject } from "../../security/credential-filter";

const initialOpenclawInferenceRouteRuntime = {
  loadInferenceSet: () =>
    require("../../actions/inference-set") as typeof import("../../actions/inference-set"),
  loadSandboxConfig: () => require("../../sandbox/config") as typeof import("../../sandbox/config"),
  loadFinalizationDeps: () =>
    require("../machine/finalization-deps") as typeof import("../machine/finalization-deps"),
};

export interface InitialOpenclawInferenceRouteDeps {
  readOpenclawConfig(sandboxName: string, gatewayName: string): ConfigObject;
  patchOpenclawInferenceConfig(
    config: ConfigObject,
    provider: string,
    model: string,
    preferredInferenceApi: string | null,
    contextWindow: undefined,
    upstreamProviderMarker: string,
    reasoningEffort: ReasoningEffortRequest,
    inheritPrimaryReplyBudget: false,
  ): { route: SandboxInferenceConfig };
  writeOpenclawInferenceConfigNatively(
    sandboxName: string,
    config: ConfigObject,
    route: SandboxInferenceConfig,
    gatewayName: string,
  ): void;
  restartNativeGateway(
    sandboxName: string,
    gatewayName: string,
  ): Promise<
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
  gatewayName: string,
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
    gatewayName,
    revalidateSandboxIdentity,
  ): Promise<void> {
    revalidateSandboxIdentity?.(`read native OpenClaw config in sandbox '${sandboxName}'`);
    const config = deps.readOpenclawConfig(sandboxName, gatewayName);
    const patched = deps.patchOpenclawInferenceConfig(
      config,
      provider,
      model,
      preferredInferenceApi,
      undefined,
      provider,
      { effort: null, explicit: false },
      false,
    );

    revalidateSandboxIdentity?.(
      `apply native OpenClaw inference route in sandbox '${sandboxName}'`,
    );
    deps.writeOpenclawInferenceConfigNatively(sandboxName, config, patched.route, gatewayName);

    revalidateSandboxIdentity?.(`restart native OpenClaw gateway in sandbox '${sandboxName}'`);
    const restart = await deps.restartNativeGateway(sandboxName, gatewayName);
    if (!restart.ok) {
      throw new Error(
        `OpenClaw native gateway restart failed after initial inference configuration (${restart.failureLayer}): ${restart.detail}`,
      );
    }
  };
}

export const initializeOpenclawInferenceRoute = createInitialOpenclawInferenceRoute({
  readOpenclawConfig: (sandboxName, gatewayName) => {
    const config = initialOpenclawInferenceRouteRuntime.loadSandboxConfig();
    return config.readSandboxConfig(
      sandboxName,
      config.resolveAgentConfig(sandboxName),
      gatewayName,
    );
  },
  patchOpenclawInferenceConfig: (...args) =>
    initialOpenclawInferenceRouteRuntime.loadInferenceSet().patchOpenClawInferenceConfig(...args),
  writeOpenclawInferenceConfigNatively: (sandboxName, config, route, gatewayName) => {
    const inferenceSet = initialOpenclawInferenceRouteRuntime.loadInferenceSet();
    inferenceSet.writeOpenClawInferenceConfigNatively(
      sandboxName,
      config,
      route,
      initialOpenclawInferenceRouteRuntime.loadSandboxConfig().setOpenClawConfigValues,
      gatewayName,
    );
  },
  restartNativeGateway: (sandboxName, gatewayName) =>
    initialOpenclawInferenceRouteRuntime
      .loadFinalizationDeps()
      .restartNativeGatewayForInitialSetup(sandboxName, gatewayName),
});
