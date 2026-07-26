// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  canFallbackToDockerGpuCompatibility,
  type DockerGpuRoutePlan,
  initialDockerGpuRoute,
} from "./docker-gpu-route";
import type { InitialSandboxPolicy } from "./initial-policy";

type PrepareInitialSandboxCreatePolicy =
  typeof import("./initial-policy").prepareInitialSandboxCreatePolicy;
type InitialPolicyOptions = Parameters<PrepareInitialSandboxCreatePolicy>[2];

export type SandboxGpuRoutePolicies = {
  initialSandboxPolicy: InitialSandboxPolicy;
  compatibilityPolicyPath: string | null;
};

/**
 * Materialize narrow native and compatibility fallback policies before sandbox-create side
 * effects. `preparePolicy` may create secure temporary files; every successful result carries its
 * cleanup, this function combines both cleanups, and a failed second materialization immediately
 * cleans the first. No provider, registry, gateway, or sandbox mutation occurs here.
 */
export function prepareSandboxGpuRoutePolicies(
  basePolicyPath: string,
  activeMessagingChannels: string[],
  options: InitialPolicyOptions,
  gpuRoutePlan: DockerGpuRoutePlan,
  preparePolicy: PrepareInitialSandboxCreatePolicy,
): SandboxGpuRoutePolicies {
  const initialCompatibility = initialDockerGpuRoute(gpuRoutePlan) === "compatibility";
  const initialSandboxPolicy = preparePolicy(basePolicyPath, activeMessagingChannels, {
    ...options,
    dockerGpuPatch: initialCompatibility,
  });
  let compatibilityPolicy: InitialSandboxPolicy | null = null;
  try {
    if (canFallbackToDockerGpuCompatibility(gpuRoutePlan)) {
      compatibilityPolicy = preparePolicy(basePolicyPath, activeMessagingChannels, {
        ...options,
        dockerGpuPatch: true,
      });
    }
  } catch (error) {
    initialSandboxPolicy.cleanup?.();
    throw error;
  }

  const cleanupFns = [initialSandboxPolicy.cleanup, compatibilityPolicy?.cleanup].filter(
    (cleanup): cleanup is () => boolean => Boolean(cleanup),
  );
  return {
    initialSandboxPolicy: {
      ...initialSandboxPolicy,
      cleanup:
        cleanupFns.length > 0
          ? () => cleanupFns.map((cleanup) => cleanup()).every(Boolean)
          : undefined,
    },
    compatibilityPolicyPath: initialCompatibility
      ? initialSandboxPolicy.policyPath
      : (compatibilityPolicy?.policyPath ?? null),
  };
}
