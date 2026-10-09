// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CheckpointGatewayAuthority } from "../../state/onboard-checkpoint-types";
import { normalizeRuntimeProviderIdentity } from "../../onboard/runtime-provider/registry";
import type { RebuildDurableConfig } from "./rebuild-durable-config";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { verifyNativeCustomStatusAttachment } from "./inference-route-health";
import { writeRestoredOpenclawInferenceRoute } from "../../onboard/openclaw/initial-inference-route";

type RebuildAuthoritativePreflightOptions = RebuildRecreateOnboardOpts & {
  deferInferenceRouteUntilOnboard?: true;
  model: string;
  provider: string;
  sandboxName: string;
};

type RebuildCompatibleEndpointSmokeOptions = Pick<
  Parameters<
    typeof import("../../onboard/compatible-endpoint-smoke").verifyCompatibleEndpointSandboxSmoke
  >[0],
  | "sandboxName"
  | "provider"
  | "model"
  | "endpointUrl"
  | "credentialEnv"
  | "nativeCustomProviderAttachment"
> & { environment: NodeJS.ProcessEnv; gatewayName?: string };

type RebuildOnboardModule = {
  verifyRebuiltOpenClawCompatibleEndpoint: (
    options: RebuildCompatibleEndpointSmokeOptions,
  ) => Promise<void>;
  ensureValidatedWebSearchCredential: (
    config: NonNullable<RebuildDurableConfig["webSearchConfig"]>,
    nonInteractive?: boolean,
  ) => Promise<unknown>;
  hydrateCredentialEnv: (name: string) => string | null;
  onboard: (options: RebuildRecreateOnboardOpts) => Promise<void>;
  preflightAuthoritativeRebuildTarget: (
    options: RebuildAuthoritativePreflightOptions,
  ) => Promise<CheckpointGatewayAuthority>;
};

type RuntimePreflightGpuDetector = Pick<
  typeof import("../../onboard/fatal-runtime-preflight"),
  "detectGpuWithRuntimeProviderProofForProvider"
>;

export function detectGpuWithRuntimeProviderProofForRebuild(
  providerId: string | null | undefined,
  loadRuntimePreflight: () => RuntimePreflightGpuDetector = () =>
    require("../../onboard/fatal-runtime-preflight") as RuntimePreflightGpuDetector,
): import("../../inference/nim").GpuDetection | null {
  try {
    const gpu = loadRuntimePreflight().detectGpuWithRuntimeProviderProofForProvider(providerId);
    return gpu?.containerGpuProof &&
      gpu.containerGpuProof.providerId !== normalizeRuntimeProviderIdentity(providerId)
      ? null
      : gpu;
  } catch {
    return null;
  }
}

function loadOnboardModule(): RebuildOnboardModule {
  return require("../../onboard") as RebuildOnboardModule;
}

/**
 * Late-bound onboarding boundary for rebuild orchestration. Rebuild imports no
 * longer initialize the full onboarding graph, and focused tests can replace
 * these calls without mutating the CommonJS cache. Remove this boundary once
 * the onboarding APIs are side-effect-free named imports.
 */
export const rebuildOnboardDependencies = {
  async refreshRestoredOpenClawInference(options: {
    sandboxName: string;
    gatewayName: string;
    provider: string;
    model: string;
    preferredInferenceApi: string | null;
    environment: NodeJS.ProcessEnv;
    attachment: NonNullable<Parameters<typeof writeRestoredOpenclawInferenceRoute>[6]>;
  }): Promise<void> {
    await verifyNativeCustomStatusAttachment({
      gatewayName: options.gatewayName,
      sandboxName: options.sandboxName,
      expected: options.attachment,
      environment: options.environment,
    });
    await writeRestoredOpenclawInferenceRoute(
      options.sandboxName,
      options.model,
      options.provider,
      options.preferredInferenceApi,
      options.gatewayName,
      undefined,
      options.attachment,
    );
  },
  verifyRebuiltOpenClawCompatibleEndpoint(
    options: RebuildCompatibleEndpointSmokeOptions,
  ): Promise<void> {
    return loadOnboardModule().verifyRebuiltOpenClawCompatibleEndpoint(options);
  },
  detectGpuWithRuntimeProviderProof(
    providerId: string | null | undefined,
  ): import("../../inference/nim").GpuDetection | null {
    return detectGpuWithRuntimeProviderProofForRebuild(providerId);
  },
  ensureValidatedWebSearchCredential(
    config: NonNullable<RebuildDurableConfig["webSearchConfig"]>,
    nonInteractive?: boolean,
  ): Promise<unknown> {
    return loadOnboardModule().ensureValidatedWebSearchCredential(config, nonInteractive);
  },
  hydrateCredentialEnv(name: string): string | null {
    return loadOnboardModule().hydrateCredentialEnv(name);
  },
  onboard(options: RebuildRecreateOnboardOpts): Promise<void> {
    return loadOnboardModule().onboard(options);
  },
  preflightAuthoritativeRebuildTarget(
    options: RebuildAuthoritativePreflightOptions,
  ): Promise<CheckpointGatewayAuthority> {
    return loadOnboardModule().preflightAuthoritativeRebuildTarget(options);
  },
};
