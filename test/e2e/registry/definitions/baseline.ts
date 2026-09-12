// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { target } from "../builder.ts";
import {
  ubuntuRepoDockerLifecycle,
  ubuntuRepoManagedRuntime,
  ubuntuRepoManagedRuntimeLifecycle,
} from "../matrix.ts";
import type { ExpectedFailureContract, TargetDefinition, TargetEnvironment } from "../types.ts";
import {
  type E2eExecutionMetadata,
  validateE2eExecutionMetadata,
} from "../../../../tools/e2e/execution-coverage.mts";
import {
  E2E_GATEWAY_RUNTIMES,
  type E2eGatewayRuntimeSupport,
} from "../../../../tools/e2e/gateway-runtime.mts";

interface CanonicalTargetInput {
  id: string;
  manifestName: string;
  environment: TargetEnvironment;
  expectedStateId: string;
  suiteIds: string[];
  onboardingAssertionIds?: string[];
  description?: string;
  executionCoverage?: E2eExecutionMetadata;
  requiredSecrets?: string[];
  expectedFailure?: ExpectedFailureContract;
  gatewayRuntimes: E2eGatewayRuntimeSupport;
}

function canonicalTarget(input: CanonicalTargetInput): TargetDefinition {
  let builder = target(input.id)
    .description(input.description ?? `Canonical typed target for ${input.id}.`)
    .manifest(`test/e2e/manifests/${input.manifestName}.yaml`)
    .environment(input.environment)
    .expectedState(input.expectedStateId)
    .onboardingAssertions(input.onboardingAssertionIds ?? ["base-installed", "preflight-passed"])
    .suites(input.suiteIds);

  if (input.requiredSecrets) {
    builder = builder.requiredSecrets(input.requiredSecrets);
  }
  if (input.expectedFailure) {
    builder = builder.expectedFailure(input.expectedFailure);
  }
  const definition = { ...builder.build(), gatewayRuntimes: input.gatewayRuntimes };
  if (!input.executionCoverage) return definition;
  return {
    ...definition,
    executionCoverage: validateE2eExecutionMetadata(
      input.executionCoverage,
      `Typed E2E target ${input.id}`,
    ),
  };
}

const canonicalTargetInputs: CanonicalTargetInput[] = [
  {
    id: "ubuntu-repo-cloud-openclaw",
    gatewayRuntimes: E2E_GATEWAY_RUNTIMES,
    manifestName: "openclaw-nvidia",
    environment: ubuntuRepoManagedRuntime("cloud-openclaw"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke", "inference", "credentials"],
    description: "Ubuntu repo checkout with managed-runtime cloud OpenClaw onboarding.",
    executionCoverage: {
      agentRuntime: "openclaw",
      observableOutcome: "Repository install onboarding and hosted inference succeed",
      environmentOrInferenceEndpoint: "Ubuntu managed-runtime host; NVIDIA hosted inference",
      unresolvedReason: "",
    },
    requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
  },
  {
    id: "ubuntu-repo-cloud-langchain-deepagents-code",
    gatewayRuntimes: E2E_GATEWAY_RUNTIMES,
    manifestName: "langchain-deepagents-code-nvidia",
    environment: ubuntuRepoManagedRuntimeLifecycle(
      "cloud-langchain-deepagents-code",
      "dcode-rebuild-invalid-credential",
    ),
    expectedStateId: "cloud-deepagents-code-ready",
    suiteIds: ["smoke", "inference", "terminal-agent", "deepagents-code-policy"],
    description: "Ubuntu repo checkout with managed-runtime Deep Agents Code onboarding.",
    executionCoverage: {
      agentRuntime: "langchain-deepagents-code",
      observableOutcome: "Repository install onboarding and hosted inference succeed",
      environmentOrInferenceEndpoint: "Ubuntu managed-runtime host; NVIDIA hosted inference",
      unresolvedReason: "",
    },
    requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
  },
  {
    // Reboot-style Docker-driver recovery without a physical reboot:
    //   1. `docker stop` the labeled sandbox container.
    //   2. Stop the OpenShell gateway runtime, then restart it through
    //      the required upstream `openshell-gateway` or marked
    //      `nemoclaw-openshell-gateway` user service.
    //   3. Run `nemoclaw <name> status` so any destructive
    //      registry/container path runs against host-observable state.
    // The state-validation phase then asserts the typed
    // `post-reboot-recovery-ready` contract: CLI installed, named
    // gateway healthy, local registry entry preserved, and labeled
    // Docker container present (running, stopped, or a
    // `*-nemoclaw-gpu-backup-*` sibling).
    id: "ubuntu-repo-docker-post-reboot-recovery",
    gatewayRuntimes: ["docker"],
    manifestName: "openclaw-nvidia-post-reboot-recovery",
    environment: ubuntuRepoDockerLifecycle("cloud-openclaw", "post-reboot-recovery"),
    expectedStateId: "post-reboot-recovery-ready",
    suiteIds: ["smoke"],
    requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
    description:
      "Post-reboot recovery guard: the gateway must recover through the required user service " +
      "while preserving the local sandbox registry and container.",
    executionCoverage: {
      agentRuntime: "openclaw",
      observableOutcome: "Docker-backed sandbox recovers after a simulated host reboot",
      environmentOrInferenceEndpoint: "Ubuntu Docker host; local recovery fixture",
      unresolvedReason: "",
    },
  },
  {
    id: "ubuntu-policy-custom-missing-presets-negative",
    gatewayRuntimes: E2E_GATEWAY_RUNTIMES,
    manifestName: "openclaw-nvidia-policy-custom-missing-presets",
    environment: ubuntuRepoManagedRuntime("cloud-openclaw-policy-custom-missing-presets"),
    expectedStateId: "onboarding-failure-policy-presets-required",
    onboardingAssertionIds: ["base-installed", "preflight-passed"],
    suiteIds: [],
    executionCoverage: {
      agentRuntime: "openclaw",
      observableOutcome: "Missing custom policy presets fail closed",
      environmentOrInferenceEndpoint: "Ubuntu Docker host; local negative fixture",
      unresolvedReason: "",
    },
    requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
    expectedFailure: {
      phase: "onboarding",
      errorClass: "policy-presets-required",
    },
  },
];

export function canonicalTargets(): TargetDefinition[] {
  return canonicalTargetInputs.map(canonicalTarget);
}

export function ubuntuRepoCloudOpenClawTarget(): TargetDefinition {
  const target = canonicalTargets().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw");
  if (!target) {
    throw new Error("Missing canonical target 'ubuntu-repo-cloud-openclaw'");
  }
  return target;
}
