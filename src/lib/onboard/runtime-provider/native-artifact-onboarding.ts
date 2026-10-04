// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { projectRuntimeProviderComputePlan, type OpenShellComputePlan } from "../compute/plan";
import type {
  RuntimeProviderBundle,
  RuntimeProviderNativeArtifactBootstrapInput,
  RuntimeProviderNativeArtifactBootstrapResult,
  RuntimeProviderNativeArtifactBootstrapSurface,
} from "./contract";

export type InactiveNativeArtifactOnboardingBootstrapInput = Omit<
  RuntimeProviderNativeArtifactBootstrapInput,
  "providerId"
>;

export interface InactiveNativeArtifactOnboardingInput {
  readonly provider: RuntimeProviderBundle;
  readonly bootstrap: InactiveNativeArtifactOnboardingBootstrapInput;
}

export interface InactiveNativeArtifactOnboardingResult {
  readonly provider: RuntimeProviderBundle;
  readonly computePlan: OpenShellComputePlan;
  readonly bootstrapResult: RuntimeProviderNativeArtifactBootstrapResult;
}

export class InactiveNativeArtifactOnboardingError extends Error {
  constructor(message: string) {
    super(`Inactive native-artifact onboarding failed: ${message}`);
    this.name = "InactiveNativeArtifactOnboardingError";
  }
}

function requireNativeArtifactBootstrap(
  provider: RuntimeProviderBundle,
): RuntimeProviderNativeArtifactBootstrapSurface {
  if (
    !provider.bootstrap.supported ||
    provider.bootstrap.providerId !== provider.identity.id ||
    provider.bootstrap.bootstrapKind !== "native-artifact"
  ) {
    throw new InactiveNativeArtifactOnboardingError(
      "the provider does not expose an identity-consistent native-artifact bootstrap contract",
    );
  }
  return provider.bootstrap;
}

async function execute(
  input: InactiveNativeArtifactOnboardingInput,
  operation: "run" | "recover",
): Promise<InactiveNativeArtifactOnboardingResult> {
  if (!input.provider.workload.supported) {
    throw new InactiveNativeArtifactOnboardingError(
      "the provider does not expose a workload contract",
    );
  }
  if (!input.provider.workload.acceptsReceipt(input.bootstrap.workload)) {
    throw new InactiveNativeArtifactOnboardingError(
      "the native artifact does not match the provider workload contract",
    );
  }
  const bootstrap = requireNativeArtifactBootstrap(input.provider);
  const bootstrapResult = await bootstrap[operation]({
    ...input.bootstrap,
    providerId: input.provider.identity.id,
  });
  return Object.freeze({
    provider: input.provider,
    computePlan: Object.freeze(projectRuntimeProviderComputePlan(input.provider)),
    bootstrapResult,
  });
}

/** Run one qualified native artifact without registering or selecting its provider. */
export function runInactiveNativeArtifactOnboarding(
  input: InactiveNativeArtifactOnboardingInput,
): Promise<InactiveNativeArtifactOnboardingResult> {
  return execute(input, "run");
}

/** Reconcile one prior native-artifact attempt through the same qualified provider. */
export function recoverInactiveNativeArtifactOnboarding(
  input: InactiveNativeArtifactOnboardingInput,
): Promise<InactiveNativeArtifactOnboardingResult> {
  return execute(input, "recover");
}
