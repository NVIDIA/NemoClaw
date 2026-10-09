// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayLifecycle } from "../../adapters/openshell/gateway-lifecycle";
import { type OpenShellRuntimeSelection } from "../../adapters/openshell/command-argv";
import { gatewayStartGuidance } from "../../gateway-start-guidance";
import type { GatewayRecoveryOutput } from "../gateway-recovery";
import { normalizeGatewayStartError } from "../gateway-start-failure";

type OnboardGpu = ReturnType<typeof import("../../inference/nim").detectGpu>;
type DynamicGatewayHelpers = ReturnType<
  typeof import("../gateway-binding").createDynamicGatewayRuntimeHelpers
>;
type GatewayReuseHelpers = ReturnType<typeof import("../gateway-reuse").createGatewayReuseHelpers>;
type DockerDriverGatewayStart = ReturnType<
  typeof import("./docker-driver-start").createDockerDriverGatewayStart
>;

export interface GatewayStartDeps {
  lifecycle: OpenShellGatewayLifecycle;
  assertGatewayStartAllowed(exitOnFailure: boolean): void;
  cliDisplayName(): string;
  dockerGpuLocalInference: typeof import("../docker-gpu-local-inference");
  dockerGpuRoute: typeof import("../docker-gpu-route");
  dockerGpuSandboxCreate: typeof import("../docker-gpu-sandbox-create");
  gatewayName(): string;
  getGatewayLocalEndpoint(): string;
  getGatewayReuseSnapshot: GatewayReuseHelpers["getGatewayReuseSnapshot"];
  isGatewayHttpReady: DynamicGatewayHelpers["isGatewayHttpReady"];
  isLinuxDockerDriverGatewayEnabled(): boolean;
  selectNamedGatewayForReuseIfNeeded: GatewayReuseHelpers["selectNamedGatewayForReuseIfNeeded"];
  startDockerDriverGateway(options?: {
    exitOnFailure?: boolean;
    output?: GatewayRecoveryOutput;
    runtimeSelection?: OpenShellRuntimeSelection;
    skipSandboxBridgeReachability?: boolean;
  }): Promise<void>;
  verifyDockerDriverGatewaySandboxReachability: DockerDriverGatewayStart["verifyDockerDriverGatewaySandboxReachability"];
  step: typeof import("../prompt-helpers").step;
}

export interface GatewayStart {
  startGateway(gpu: OnboardGpu, options?: { gpuPassthrough?: boolean }): Promise<void>;
  verifyReusableDockerDriverGatewaySandboxReachability(
    gpu: OnboardGpu,
    options: { gpuPassthrough: boolean },
  ): Promise<void>;
  startGatewayWithOptions(
    gpu: OnboardGpu,
    options?: {
      exitOnFailure?: boolean;
      gpuPassthrough?: boolean;
      output?: GatewayRecoveryOutput;
      runtimeSelection?: OpenShellRuntimeSelection;
    },
  ): Promise<void>;
}

export function createGatewayStart(deps: GatewayStartDeps): GatewayStart {
  function skipSandboxBridgeReachability(gpu: OnboardGpu, gpuPassthrough: boolean): boolean {
    const selectedGpuRoute = deps.dockerGpuRoute.initialDockerGpuRoute(
      deps.dockerGpuRoute.resolveDockerGpuRoutePlan(
        { sandboxGpuEnabled: gpuPassthrough, hostGpuPlatform: gpu?.platform },
        {
          dockerDriverGateway: true,
          dockerDesktopWsl: deps.dockerGpuSandboxCreate.isDockerDesktopWslRuntime(),
        },
      ),
    );
    return deps.dockerGpuLocalInference.shouldSkipGpuBridgeProbe(
      gpuPassthrough,
      gpu?.platform,
      selectedGpuRoute,
    );
  }

  async function verifyReusableDockerDriverGatewaySandboxReachability(
    gpu: OnboardGpu,
    { gpuPassthrough }: { gpuPassthrough: boolean },
  ): Promise<void> {
    await deps.verifyDockerDriverGatewaySandboxReachability({
      exitOnFailure: true,
      skipSandboxBridgeReachability: skipSandboxBridgeReachability(gpu, gpuPassthrough),
    });
  }

  async function startGatewayWithOptions(
    gpu: OnboardGpu,
    {
      exitOnFailure = true,
      gpuPassthrough = false,
      output,
      runtimeSelection,
    }: {
      exitOnFailure?: boolean;
      gpuPassthrough?: boolean;
      output?: GatewayRecoveryOutput;
      runtimeSelection?: OpenShellRuntimeSelection;
    } = {},
  ): Promise<void> {
    deps.assertGatewayStartAllowed(exitOnFailure);
    (output?.step ?? deps.step)(2, 8, "Starting OpenShell gateway");
    if (deps.isLinuxDockerDriverGatewayEnabled()) {
      return deps.startDockerDriverGateway({
        exitOnFailure,
        ...(output ? { output } : {}),
        ...(runtimeSelection ? { runtimeSelection } : {}),
        skipSandboxBridgeReachability: skipSandboxBridgeReachability(gpu, gpuPassthrough),
      });
    }

    const snapshot = await deps.selectNamedGatewayForReuseIfNeeded(
      await deps.getGatewayReuseSnapshot(runtimeSelection),
      runtimeSelection,
    );
    if (snapshot.healthy) {
      // CLI metadata can remain healthy after a restart. Probe HTTP before reuse to
      // prevent a later connection failure (#3258).
      if (await deps.isGatewayHttpReady()) {
        (output?.log ?? console.log)("  ✓ Reusing existing gateway");
        const selected = await deps.lifecycle.selectGateway({
          target: { kind: "named", gatewayName: deps.gatewayName() },
          runtimeSelection,
        });
        if (!selected.ok) throw new Error(selected.error.message);
        process.env.OPENSHELL_GATEWAY = deps.gatewayName();
        return;
      }
      (output?.log ?? console.log)(
        `  Gateway metadata reports healthy but ${deps.getGatewayLocalEndpoint()}/ is not responding.`,
      );
    }
    if (snapshot.namedMetadata) {
      (output?.log ?? console.log)("  Stale gateway detected.");
    }

    // The deployment owns this gateway lifecycle. NemoClaw can reuse the gateway
    // but cannot start it.
    const message = `${deps.cliDisplayName()} does not start the '${deps.gatewayName()}' gateway on this host.`;
    (output?.error ?? console.error)(`  ${gatewayStartGuidance(deps.gatewayName())}`);
    if (exitOnFailure) process.exit(1);
    throw normalizeGatewayStartError(new Error(message));
  }

  async function startGateway(
    gpu: OnboardGpu,
    { gpuPassthrough = false }: { gpuPassthrough?: boolean } = {},
  ): Promise<void> {
    return startGatewayWithOptions(gpu, { exitOnFailure: true, gpuPassthrough });
  }

  return {
    startGateway,
    startGatewayWithOptions,
    verifyReusableDockerDriverGatewaySandboxReachability,
  };
}
