// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { destroyGatewayForReuse } from "../gateway-cleanup";
import { verifyGatewayContainerRunning } from "../gateway-container-running";
import type { flowDeps as externalComponentFlowDeps } from "../external-component/onboarding";
import {
  createInitialOnboardFlowPhases as createInitialFlowPhases,
  type InitialOnboardFlowContext,
  type InitialOnboardFlowPhaseOptions,
} from "./initial-flow-phases";

export { destroyGatewayForReuse } from "../gateway-cleanup";
export { verifyGatewayContainerRunning } from "../gateway-container-running";
export * as externalComponent from "../external-component/onboarding";
export { applyHealthyPortReuse } from "./gateway-stale-port-reuse";
export { type InitialOnboardFlowContext, runInitialOnboardFlowSlice } from "./initial-flow-phases";

const gatewayDeps = {
  destroyGatewayForReuse,
  verifyGatewayContainerRunning,
};

type GatewayDeps = typeof gatewayDeps;
type ExternalComponentGatewayDeps = Pick<
  ReturnType<typeof externalComponentFlowDeps>,
  "assertExternalComponentFreshSandbox" | "configureExternalComponentGateway"
>;

export type InitialOnboardFlowCompositionOptions<
  Context extends InitialOnboardFlowContext<Agent, Gpu, Config>,
  Agent,
  Gpu,
  SandboxEntry,
  Host,
  Config extends import("./handlers/preflight").PreflightSandboxGpuConfig,
> = Omit<
  InitialOnboardFlowPhaseOptions<Context, Agent, Gpu, SandboxEntry, Host, Config>,
  "gatewayDeps"
> &
  ExternalComponentGatewayDeps & {
    gatewayDeps: Omit<
      InitialOnboardFlowPhaseOptions<
        Context,
        Agent,
        Gpu,
        SandboxEntry,
        Host,
        Config
      >["gatewayDeps"],
      keyof GatewayDeps | keyof ExternalComponentGatewayDeps
    >;
  };

export function createInitialOnboardFlowPhases<
  Context extends InitialOnboardFlowContext<Agent, Gpu, Config>,
  Agent,
  Gpu,
  SandboxEntry,
  Host,
  Config extends import("./handlers/preflight").PreflightSandboxGpuConfig,
>(
  options: InitialOnboardFlowCompositionOptions<Context, Agent, Gpu, SandboxEntry, Host, Config>,
): ReturnType<typeof createInitialFlowPhases<Context, Agent, Gpu, SandboxEntry, Host, Config>> {
  const {
    assertExternalComponentFreshSandbox,
    configureExternalComponentGateway,
    ...phaseOptions
  } = options;
  return createInitialFlowPhases<Context, Agent, Gpu, SandboxEntry, Host, Config>({
    ...phaseOptions,
    gatewayDeps: {
      ...phaseOptions.gatewayDeps,
      ...gatewayDeps,
      assertExternalComponentFreshSandbox,
      configureExternalComponentGateway,
    },
  });
}
