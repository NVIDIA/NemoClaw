// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type OpenShellRuntimeSelection,
  withSelectedOpenShellCommandOptions,
} from "../../adapters/openshell/command-argv";
import { gatewayStartGuidance } from "../../gateway-start-guidance";
import { normalizeGatewayStartError } from "../gateway-start-failure";

type OnboardGpu = ReturnType<typeof import("../../inference/nim").detectGpu>;
type DynamicGatewayHelpers = ReturnType<
  typeof import("../gateway-binding").createDynamicGatewayRuntimeHelpers
>;
type GatewayReuseHelpers = ReturnType<typeof import("../gateway-reuse").createGatewayReuseHelpers>;

export interface GatewayStartDeps {
  assertGatewayStartAllowed(exitOnFailure: boolean): void;
  cliDisplayName(): string;
  dockerGpuLocalInference: typeof import("../docker-gpu-local-inference");
  dockerGpuRoute: typeof import("../docker-gpu-route");
  dockerGpuSandboxCreate: typeof import("../docker-gpu-sandbox-create");
  gatewayName(): string;
  getGatewayLocalEndpoint(): string;
  getGatewayReuseSnapshot: GatewayReuseHelpers["getGatewayReuseSnapshot"];
  hasStaleGateway(gatewayInfo: string): boolean;
  isGatewayHealthy(status: string, namedInfo: string, activeInfo: string): boolean;
  isGatewayHttpReady: DynamicGatewayHelpers["isGatewayHttpReady"];
  isLinuxDockerDriverGatewayEnabled(): boolean;
  runOpenshell(
    args: string[],
    options?: {
      env?: Record<string, string>;
      ignoreError?: boolean;
      replaceEnv?: boolean;
    },
  ): unknown;
  selectNamedGatewayForReuseIfNeeded: GatewayReuseHelpers["selectNamedGatewayForReuseIfNeeded"];
  startDockerDriverGateway(options?: {
    exitOnFailure?: boolean;
    runtimeSelection?: OpenShellRuntimeSelection;
    skipSandboxBridgeReachability?: boolean;
  }): Promise<void>;
  step: typeof import("../prompt-helpers").step;
}

export interface GatewayStart {
  startGateway(gpu: OnboardGpu, options?: { gpuPassthrough?: boolean }): Promise<void>;
  startGatewayWithOptions(
    gpu: OnboardGpu,
    options?: {
      exitOnFailure?: boolean;
      gpuPassthrough?: boolean;
      runtimeSelection?: OpenShellRuntimeSelection;
    },
  ): Promise<void>;
}

export function createGatewayStart(deps: GatewayStartDeps): GatewayStart {
  async function startGatewayWithOptions(
    gpu: OnboardGpu,
    {
      exitOnFailure = true,
      gpuPassthrough = false,
      runtimeSelection,
    }: {
      exitOnFailure?: boolean;
      gpuPassthrough?: boolean;
      runtimeSelection?: OpenShellRuntimeSelection;
    } = {},
  ): Promise<void> {
    deps.assertGatewayStartAllowed(exitOnFailure);
    deps.step(2, 8, "Starting OpenShell gateway");
    if (deps.isLinuxDockerDriverGatewayEnabled()) {
      const selectedGpuRoute = deps.dockerGpuRoute.initialDockerGpuRoute(
        deps.dockerGpuRoute.resolveDockerGpuRoutePlan(
          { sandboxGpuEnabled: gpuPassthrough, hostGpuPlatform: gpu?.platform },
          {
            dockerDriverGateway: true,
            dockerDesktopWsl: deps.dockerGpuSandboxCreate.isDockerDesktopWslRuntime(),
          },
        ),
      );
      return deps.startDockerDriverGateway({
        exitOnFailure,
        ...(runtimeSelection ? { runtimeSelection } : {}),
        skipSandboxBridgeReachability: deps.dockerGpuLocalInference.shouldSkipGpuBridgeProbe(
          gpuPassthrough,
          gpu?.platform,
          selectedGpuRoute,
        ),
      });
    }

    const snapshot = deps.selectNamedGatewayForReuseIfNeeded(
      deps.getGatewayReuseSnapshot(runtimeSelection),
      runtimeSelection,
    );
    if (
      deps.isGatewayHealthy(snapshot.gatewayStatus, snapshot.gwInfo, snapshot.activeGatewayInfo)
    ) {
      // CLI metadata can remain healthy after a restart. Probe HTTP before reuse to
      // prevent a later connection failure (#3258).
      if (await deps.isGatewayHttpReady()) {
        console.log("  ✓ Reusing existing gateway");
        deps.runOpenshell(
          ["gateway", "select", deps.gatewayName()],
          withSelectedOpenShellCommandOptions({ ignoreError: true }, runtimeSelection),
        );
        process.env.OPENSHELL_GATEWAY = deps.gatewayName();
        return;
      }
      console.log(
        `  Gateway metadata reports healthy but ${deps.getGatewayLocalEndpoint()}/ is not responding.`,
      );
    }
    if (deps.hasStaleGateway(snapshot.gwInfo)) console.log("  Stale gateway detected.");

    // The deployment owns this gateway lifecycle. NemoClaw can reuse the gateway
    // but cannot start it.
    const message = `${deps.cliDisplayName()} does not start the '${deps.gatewayName()}' gateway on this host.`;
    console.error(`  ${gatewayStartGuidance(deps.gatewayName())}`);
    if (exitOnFailure) process.exit(1);
    throw normalizeGatewayStartError(new Error(message));
  }

  async function startGateway(
    gpu: OnboardGpu,
    { gpuPassthrough = false }: { gpuPassthrough?: boolean } = {},
  ): Promise<void> {
    return startGatewayWithOptions(gpu, { exitOnFailure: true, gpuPassthrough });
  }

  return { startGateway, startGatewayWithOptions };
}
