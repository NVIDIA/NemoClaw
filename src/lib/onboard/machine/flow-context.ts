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

export type ProviderModelSelectedOnboardFlowContext<Context extends OnboardFlowContext> =
  Context & {
    model: string;
    provider: string;
  };

export type ProviderSelectedOnboardFlowContext<Context extends OnboardFlowContext> =
  ProviderModelSelectedOnboardFlowContext<Context> & {
    sandboxGpuConfig: NonNullable<Context["sandboxGpuConfig"]>;
  };

export type SandboxCreatedOnboardFlowContext<Context extends OnboardFlowContext> = Context & {
  sandboxName: string;
  model: string;
  provider: string;
};

export type FinalOnboardFlowContext<Context extends OnboardFlowContext> =
  SandboxCreatedOnboardFlowContext<Context>;

export interface OnboardFlowPhaseResult<Context extends OnboardFlowContext = OnboardFlowContext> {
  context: Context;
  result: OnboardStateHandlerResult;
}

export interface ProviderModelSelectedContextUpdate {
  session: Session | null;
  sandboxName: string | null;
  model: string;
  provider: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: string | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  nimContainer: string | null;
  webSearchConfig: WebSearchConfig | null;
}

export interface SandboxCreatedContextUpdate {
  session: Session | null;
  sandboxName: string;
  webSearchConfig: WebSearchConfig | null;
  selectedMessagingChannels: string[];
  webSearchSupported: boolean;
}

export function assertProviderModelSelectedContext<Context extends OnboardFlowContext>(
  context: Context,
  stepName: string,
): asserts context is ProviderModelSelectedOnboardFlowContext<Context> {
  if (!context.model || !context.provider) {
    throw new Error(`Onboarding state is incomplete before ${stepName}.`);
  }
}

export function assertProviderSelectedContext<Context extends OnboardFlowContext>(
  context: Context,
  stepName: string,
): asserts context is ProviderSelectedOnboardFlowContext<Context> {
  assertProviderModelSelectedContext(context, stepName);
  if (!context.sandboxGpuConfig) {
    throw new Error(`Onboarding state is incomplete before ${stepName}.`);
  }
}

export function assertSandboxCreatedContext<Context extends OnboardFlowContext>(
  context: Context,
  stepName: string,
): asserts context is SandboxCreatedOnboardFlowContext<Context> {
  if (!context.sandboxName || !context.model || !context.provider) {
    throw new Error(`Onboarding state is incomplete before ${stepName}.`);
  }
}

export function mergeOnboardFlowContext<Context extends OnboardFlowContext>(
  context: Context,
  patch: Partial<Context>,
): Context {
  return { ...context, ...patch };
}

export function mergeProviderModelSelectedContext<Context extends OnboardFlowContext>(
  context: Context,
  patch: ProviderModelSelectedContextUpdate,
): ProviderModelSelectedOnboardFlowContext<Context> {
  return { ...context, ...patch };
}

export function mergeSandboxCreatedContext<Context extends OnboardFlowContext>(
  context: ProviderModelSelectedOnboardFlowContext<Context>,
  patch: SandboxCreatedContextUpdate,
): SandboxCreatedOnboardFlowContext<Context> {
  return { ...context, ...patch };
}

export function onboardFlowPhaseResult<Context extends OnboardFlowContext>(
  context: Context,
  result: OnboardStateHandlerResult,
): OnboardFlowPhaseResult<Context> {
  return { context, result };
}
