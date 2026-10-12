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

export type InitialInferenceSelection = {
  endpointUrl?: string | null;
  nativeProvider: boolean;
};

export interface InitialOpenclawInferenceRouteDeps {
  readInferenceSelection?(
    sandboxName: string,
    gatewayName: string,
    provider: string,
  ): InitialInferenceSelection;
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
    nativeEndpointUrl?: string,
    nativeProvider?: boolean,
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
  selection?: InitialInferenceSelection,
) => Promise<void>;

export function createOpenclawInferenceRouteWriter(
  deps: Omit<InitialOpenclawInferenceRouteDeps, "restartNativeGateway">,
): InitializeOpenclawInferenceRoute {
  return async function initializeOpenclawInferenceRoute(
    sandboxName,
    model,
    provider,
    preferredInferenceApi,
    gatewayName,
    revalidateSandboxIdentity,
    selection,
  ): Promise<void> {
    revalidateSandboxIdentity?.(`read native OpenClaw config in sandbox '${sandboxName}'`);
    const selected = selection ?? deps.readInferenceSelection?.(sandboxName, gatewayName, provider);
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
      selected?.endpointUrl ?? undefined,
      selected?.nativeProvider ?? true,
    );

    revalidateSandboxIdentity?.(
      `apply native OpenClaw inference route in sandbox '${sandboxName}'`,
    );
    deps.writeOpenclawInferenceConfigNatively(sandboxName, config, patched.route, gatewayName);
  };
}

export function createInitialOpenclawInferenceRoute(
  deps: InitialOpenclawInferenceRouteDeps,
): InitializeOpenclawInferenceRoute {
  const write = createOpenclawInferenceRouteWriter(deps);
  return async (
    sandboxName,
    model,
    provider,
    preferredInferenceApi,
    gatewayName,
    revalidateSandboxIdentity,
    selection,
  ) => {
    await write(
      sandboxName,
      model,
      provider,
      preferredInferenceApi,
      gatewayName,
      revalidateSandboxIdentity,
      selection,
    );
    revalidateSandboxIdentity?.(`restart native OpenClaw gateway in sandbox '${sandboxName}'`);
    const restart = await deps.restartNativeGateway(sandboxName, gatewayName);
    if (!restart.ok) {
      throw new Error(
        `OpenClaw native gateway restart failed after initial inference configuration (${restart.failureLayer}): ${restart.detail}`,
      );
    }
  };
}

const nativeInferenceRouteDeps: InitialOpenclawInferenceRouteDeps = {
  readInferenceSelection: (sandboxName, gatewayName, provider) => {
    const { load } =
      require("../../state/registry/persistence") as typeof import("../../state/registry/persistence");
    const entry = load().sandboxes[sandboxName];
    if (!entry || entry.gatewayName !== gatewayName || entry.provider !== provider) {
      throw new Error("Initial OpenClaw inference route does not match its registered selection.");
    }
    return {
      endpointUrl: entry.endpointUrl,
      nativeProvider: Boolean(
        entry.nativeHostedProviderAttachment || entry.nativeNvidiaProviderAttachment,
      ),
    };
  },
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
};

export const initializeOpenclawInferenceRoute =
  createInitialOpenclawInferenceRoute(nativeInferenceRouteDeps);

/** The caller owns the offline restore window and its subsequent gateway restart. */
export const writeRestoredOpenclawInferenceRoute =
  createOpenclawInferenceRouteWriter(nativeInferenceRouteDeps);
