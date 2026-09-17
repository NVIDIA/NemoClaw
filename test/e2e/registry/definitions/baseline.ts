// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { TargetDefinition } from "../types.ts";
import { ubuntuRepoManagedRuntime, ubuntuRepoManagedRuntimeLifecycle } from "../matrix.ts";
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
