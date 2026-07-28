// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardFlowContext } from "./flow-context";
import type { OnboardMachineRunnerResult } from "./runner";

type InitialHandoffContext<Gpu, SandboxGpuConfig> = OnboardFlowContext & {
  readonly gpu: Gpu | null;
  readonly sandboxGpuConfig: SandboxGpuConfig | null;
  readonly gpuPassthrough: boolean;
};

export function prepareCoreOnboardFlowContext<
  Context extends InitialHandoffContext<Gpu, SandboxGpuConfig>,
  Gpu,
  SandboxGpuConfig,
>(options: {
  initial: OnboardMachineRunnerResult<Context>;
  recordedSandboxName: string | null;
  requestedSandboxName: string | null;
  checkpointedSandboxName: string | null;
  selectedMessagingChannels: string[];
  assertSandboxNameAllowed(sandboxName: string): void;
}): Context & { sandboxGpuConfig: SandboxGpuConfig } {
  const context = options.initial.context;
  if (!context.sandboxGpuConfig) {
    throw new Error("Preflight did not produce a sandbox GPU configuration.");
  }
  const sandboxName =
    options.recordedSandboxName ||
    options.requestedSandboxName ||
    options.checkpointedSandboxName ||
    null;
  if (sandboxName) options.assertSandboxNameAllowed(sandboxName);
  return {
    ...context,
    session: options.initial.session,
    sandboxName,
    selectedMessagingChannels: options.selectedMessagingChannels,
    gpu: context.gpu ?? null,
    sandboxGpuConfig: context.sandboxGpuConfig,
    gpuPassthrough: context.gpuPassthrough,
  };
}

export function prepareFinalOnboardFlowContext<Context extends OnboardFlowContext>(
  core: OnboardMachineRunnerResult<Context>,
): Context & { sandboxName: string; model: string; provider: string } {
  const context = core.context;
  if (!context.sandboxName || !context.model || !context.provider) {
    throw new Error("Onboarding state is incomplete after sandbox setup.");
  }
  return {
    ...context,
    session: core.session,
    sandboxName: context.sandboxName,
    model: context.model,
    provider: context.provider,
  };
}
