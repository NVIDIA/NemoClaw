// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { TargetDefinition } from "../types.ts";
import {
  ubuntuRepoDockerLifecycle,
  ubuntuRepoManagedRuntime,
  ubuntuRepoManagedRuntimeLifecycle,
} from "../matrix.ts";
import { E2E_GATEWAY_RUNTIMES } from "../../../../tools/e2e/gateway-runtime.mts";

const TARGETS: readonly TargetDefinition[] = [
  {
    id: "ubuntu-repo-cloud-openclaw",
    description: "Ubuntu repo checkout with managed-runtime cloud OpenClaw onboarding.",
    executionCoverage: {
      agentRuntime: "openclaw",
      observableOutcome: "Repository install onboarding and hosted inference succeed",
      environmentOrInferenceEndpoint: "Ubuntu managed-runtime host; NVIDIA hosted inference",
      unresolvedReason: "",
    },
    manifestPath: "test/e2e/manifests/openclaw-nvidia.yaml",
    environment: ubuntuRepoManagedRuntime("cloud-openclaw"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke", "inference", "credentials"],
    requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
    gatewayRuntimes: E2E_GATEWAY_RUNTIMES,
  },
  {
    id: "ubuntu-repo-cloud-langchain-deepagents-code",
    description: "Ubuntu repo checkout with managed-runtime Deep Agents Code onboarding.",
    executionCoverage: {
      agentRuntime: "langchain-deepagents-code",
      observableOutcome: "Repository install onboarding and hosted inference succeed",
      environmentOrInferenceEndpoint: "Ubuntu managed-runtime host; NVIDIA hosted inference",
      unresolvedReason: "",
    },
    manifestPath: "test/e2e/manifests/langchain-deepagents-code-nvidia.yaml",
    environment: ubuntuRepoManagedRuntimeLifecycle(
      "cloud-langchain-deepagents-code",
      "dcode-rebuild-invalid-credential",
    ),
    expectedStateId: "cloud-deepagents-code-ready",
    suiteIds: ["smoke", "inference", "terminal-agent", "deepagents-code-policy"],
    requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
    gatewayRuntimes: E2E_GATEWAY_RUNTIMES,
  },
  {
    id: "ubuntu-repo-docker-post-reboot-recovery",
    description:
      "Post-reboot recovery guard: the gateway must recover through the required user service " +
      "while preserving the local sandbox registry and container.",
    executionCoverage: {
      agentRuntime: "openclaw",
      observableOutcome: "Docker-backed sandbox recovers after a simulated host reboot",
      environmentOrInferenceEndpoint: "Ubuntu Docker host; local recovery fixture",
      unresolvedReason: "",
    },
    manifestPath: "test/e2e/manifests/openclaw-nvidia-post-reboot-recovery.yaml",
    environment: ubuntuRepoDockerLifecycle("cloud-openclaw", "post-reboot-recovery"),
    expectedStateId: "post-reboot-recovery-ready",
    suiteIds: ["smoke"],
    requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
    gatewayRuntimes: ["docker"],
  },
  {
    id: "ubuntu-policy-custom-missing-presets-negative",
    description: "Missing custom policy presets fail closed.",
    executionCoverage: {
      agentRuntime: "openclaw",
      observableOutcome: "Missing custom policy presets fail closed",
      environmentOrInferenceEndpoint: "Ubuntu Docker host; local negative fixture",
      unresolvedReason: "",
    },
    manifestPath: "test/e2e/manifests/openclaw-nvidia-policy-custom-missing-presets.yaml",
    environment: ubuntuRepoManagedRuntime("cloud-openclaw-policy-custom-missing-presets"),
    expectedStateId: "onboarding-failure-policy-presets-required",
    suiteIds: [],
    requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
    gatewayRuntimes: E2E_GATEWAY_RUNTIMES,
  },
];

export function canonicalTargets(): TargetDefinition[] {
  return [...TARGETS];
}
