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
  loadRegistry: () =>
    require("../../state/registry/persistence") as typeof import("../../state/registry/persistence"),
  loadLifecycleLock: () =>
    require("../../actions/sandbox/lifecycle/lock") as typeof import("../../actions/sandbox/lifecycle/lock"),
  loadOpenShellLifecycle: () =>
    require("../../adapters/openshell/sandbox-lifecycle-sdk") as typeof import("../../adapters/openshell/sandbox-lifecycle-sdk"),
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

async function restartInitialExternalOpenclawSandbox(
  sandboxName: string,
  gatewayName: string,
  expectedIdentity: string | undefined,
): ReturnType<InitialOpenclawInferenceRouteDeps["restartNativeGateway"]> {
  const runtime = initialOpenclawInferenceRouteRuntime;
  return runtime.loadLifecycleLock().withSandboxLifecycleLock(sandboxName, async () => {
    const sandbox = runtime.loadRegistry().load().sandboxes[sandboxName];
    if (
      sandbox?.workload?.kind !== "external-image" ||
      sandbox.openshellDriver !== "docker" ||
      !expectedIdentity ||
      sandbox.lifecycleLiveIdentityFingerprint !== expectedIdentity ||
      (sandbox.gatewayName && sandbox.gatewayName !== gatewayName)
    ) {
      return {
        ok: false as const,
        failureLayer: "OpenShell lifecycle identity",
        detail: "External-image sandbox ownership changed before initial restart.",
      };
    }
    const lifecycle = runtime.loadOpenShellLifecycle().createSdkOpenShellSandboxStateLifecycle();
    const request = {
      sandboxName,
      sandboxIdentityFingerprint: expectedIdentity,
      target: { kind: "named" as const, gatewayName },
    };
    // Initial setup must not require an administrative grant for the agent's CLI device.
    // OpenShell owns the sandbox lifecycle and verifies the same identity at both transitions.
    for (const action of ["stop", "start"] as const) {
      const result = await lifecycle[`${action}Sandbox`](request);
      if (result.kind === "failed") {
        return {
          ok: false as const,
          failureLayer: "OpenShell lifecycle",
          detail: `OpenShell ${action} failed: ${result.error.message}`,
        };
      }
    }
    const ready = await runtime
      .loadFinalizationDeps()
      .finalizationHandlerDeps.waitForStartedOpenclawGatewayProcess(sandboxName, gatewayName);
    return ready === true
      ? { ok: true as const }
      : {
          ok: false as const,
          failureLayer: "native gateway startup",
          detail: "OpenClaw did not become ready after the initial OpenShell restart.",
        };
  });
}

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
  restartNativeGateway: (sandboxName, gatewayName) => {
    const sandbox = initialOpenclawInferenceRouteRuntime.loadRegistry().load().sandboxes[
      sandboxName
    ];
    return sandbox?.workload?.kind === "external-image"
      ? restartInitialExternalOpenclawSandbox(
          sandboxName,
          gatewayName,
          sandbox.lifecycleLiveIdentityFingerprint,
        )
      : initialOpenclawInferenceRouteRuntime
          .loadFinalizationDeps()
          .restartNativeGatewayForInitialSetup(sandboxName, gatewayName);
  },
});
