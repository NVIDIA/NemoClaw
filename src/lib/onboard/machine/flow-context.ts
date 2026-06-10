// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../../inference/web-search";
import type { Session } from "../../state/onboard-session";
import type { OnboardStateHandlerResult } from "./runner";

export interface OnboardFlowContext<Agent = unknown, Gpu = unknown, SandboxGpuConfig = unknown> {
  resume: boolean;
  fresh: boolean;
  session: Session | null;
  agent: Agent;
  recordedSandboxName: string | null;
  requestedSandboxName: string | null;
  sandboxName: string | null;
  fromDockerfile: string | null;
  model: string | null;
  provider: string | null;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: string | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  nimContainer: string | null;
  webSearchConfig: WebSearchConfig | null;
  webSearchSupported: boolean;
  selectedMessagingChannels: string[];
  gpu: Gpu | null;
  sandboxGpuConfig: SandboxGpuConfig | null;
  gpuPassthrough: boolean;
}

export interface OnboardFlowPhaseResult<Context extends OnboardFlowContext = OnboardFlowContext> {
  context: Context;
  result: OnboardStateHandlerResult;
}

export function mergeOnboardFlowContext<Context extends OnboardFlowContext>(
  context: Context,
  patch: Partial<Context>,
): Context {
  return { ...context, ...patch };
}

export function onboardFlowPhaseResult<Context extends OnboardFlowContext>(
  context: Context,
  result: OnboardStateHandlerResult,
): OnboardFlowPhaseResult<Context> {
  return { context, result };
}
