// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertionGroupsForScenario } from "../assertions/registry.ts";
import { scenario } from "../builder.ts";
import {
  brevLaunchableRemote,
  gpuRepoDockerCdi,
  macosRepoDocker,
  ubuntuRepoDocker,
  ubuntuRepoNoDocker,
  wslRepoDocker,
} from "../matrix.ts";
import type { ScenarioDefinition, ScenarioEnvironment } from "../types.ts";

interface CanonicalScenarioInput {
  id: string;
  manifestName: string;
  environment: ScenarioEnvironment;
  expectedStateId: string;
  suiteIds: string[];
  onboardingAssertionIds?: string[];
  description?: string;
  runnerRequirements?: string[];
  requiredSecrets?: string[];
  skippedCapabilities?: Array<Record<string, unknown>>;
  expectedFailure?: Record<string, unknown>;
}

function canonicalScenario(input: CanonicalScenarioInput): ScenarioDefinition {
  let builder = scenario(input.id)
    .description(input.description ?? `Canonical typed scenario for ${input.id}.`)
    .manifest(`test/e2e-scenario/manifests/${input.manifestName}.yaml`)
    .environment(input.environment)
    .expectedState(input.expectedStateId)
    .onboardingAssertions(input.onboardingAssertionIds ?? ["base-installed", "preflight-passed"])
    .suites(input.suiteIds);

  if (input.runnerRequirements) {
    builder = builder.runnerRequirements(input.runnerRequirements);
  }
  if (input.requiredSecrets) {
    builder = builder.requiredSecrets(input.requiredSecrets);
  }
  if (input.skippedCapabilities) {
    builder = builder.skippedCapabilities(input.skippedCapabilities);
  }
  if (input.expectedFailure) {
    builder = builder.expectedFailure(input.expectedFailure);
  }
  builder = builder.assertions(assertionGroupsForScenario(builder.build()));
  return builder.build();
}

const macosDockerSkipped = [
  {
    id: "macos-docker-dependent-suites",
    reason:
      "GitHub-hosted macOS runners do not provide a reachable Docker daemon; gateway/sandbox/inference suites are reported as skipped instead of failing this scenario.",
    suites: ["smoke", "inference", "credentials"],
  },
];

const canonicalScenarioInputs: CanonicalScenarioInput[] = [
  {
    id: "ubuntu-repo-cloud-openclaw",
    manifestName: "openclaw-nvidia",
    environment: ubuntuRepoDocker("cloud-openclaw"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke", "inference", "credentials"],
    description: "Ubuntu repo checkout with Docker and cloud OpenClaw onboarding.",
    requiredSecrets: ["NVIDIA_API_KEY"],
  },
  {
    id: "ubuntu-repo-cloud-hermes",
    manifestName: "hermes-nvidia",
    environment: ubuntuRepoDocker("cloud-hermes"),
    expectedStateId: "cloud-hermes-ready",
    suiteIds: ["smoke", "inference", "hermes-specific"],
    requiredSecrets: ["NVIDIA_API_KEY"],
  },
  {
    id: "gpu-repo-local-ollama-openclaw",
    manifestName: "openclaw-ollama-gpu",
    environment: gpuRepoDockerCdi("local-ollama-openclaw"),
    expectedStateId: "local-ollama-openclaw-ready",
    suiteIds: ["smoke", "local-ollama-inference", "ollama-proxy"],
    runnerRequirements: ["self-hosted-gpu", "docker-cdi"],
  },
  {
    id: "macos-repo-cloud-openclaw",
    manifestName: "openclaw-nvidia-macos",
    environment: macosRepoDocker("cloud-openclaw"),
    expectedStateId: "macos-cli-ready-docker-optional",
    onboardingAssertionIds: ["base-installed"],
    suiteIds: ["platform-macos"],
    runnerRequirements: ["macos-latest"],
    requiredSecrets: ["NVIDIA_API_KEY"],
    skippedCapabilities: macosDockerSkipped,
  },
  {
    id: "wsl-repo-cloud-openclaw",
    manifestName: "openclaw-nvidia-wsl",
    environment: wslRepoDocker("cloud-openclaw"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke", "platform-wsl"],
    runnerRequirements: ["windows-latest", "wsl2"],
    requiredSecrets: ["NVIDIA_API_KEY"],
  },
  {
    id: "brev-launchable-cloud-openclaw",
    manifestName: "openclaw-nvidia-brev-launchable",
    environment: brevLaunchableRemote("cloud-openclaw"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke", "inference"],
    runnerRequirements: ["ubuntu-latest", "brev-api-token", "launchable-image"],
    requiredSecrets: ["NVIDIA_API_KEY"],
  },
  {
    id: "ubuntu-no-docker-preflight-negative",
    manifestName: "openclaw-nvidia-no-docker-negative",
    environment: ubuntuRepoNoDocker("cloud-openclaw"),
    expectedStateId: "preflight-failure-no-sandbox",
    onboardingAssertionIds: ["base-installed", "preflight-expected-failed"],
    suiteIds: [],
    requiredSecrets: ["NVIDIA_API_KEY"],
    expectedFailure: {
      phase: "preflight",
      errorClass: "docker-missing",
      forbiddenSideEffects: ["gateway-started", "sandbox-created"],
    },
  },
  {
    id: "ubuntu-repo-openai-compatible-openclaw",
    manifestName: "openclaw-openai-compatible",
    environment: ubuntuRepoDocker("openai-compatible-openclaw"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke"],
    requiredSecrets: ["OPENAI_COMPATIBLE_API_KEY"],
  },
  {
    id: "ubuntu-repo-cloud-openclaw-brave",
    manifestName: "openclaw-nvidia-brave",
    environment: ubuntuRepoDocker("cloud-nvidia-openclaw-brave"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke"],
    requiredSecrets: ["NVIDIA_API_KEY", "BRAVE_API_KEY"],
  },
  {
    id: "ubuntu-repo-cloud-openclaw-telegram",
    manifestName: "openclaw-nvidia-telegram",
    environment: ubuntuRepoDocker("cloud-nvidia-openclaw-telegram"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke", "messaging-telegram"],
    requiredSecrets: ["NVIDIA_API_KEY", "TELEGRAM_BOT_TOKEN"],
  },
  {
    id: "ubuntu-repo-cloud-openclaw-discord",
    manifestName: "openclaw-nvidia-discord",
    environment: ubuntuRepoDocker("cloud-nvidia-openclaw-discord"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke", "messaging-discord"],
    requiredSecrets: ["NVIDIA_API_KEY", "DISCORD_BOT_TOKEN"],
  },
  {
    id: "ubuntu-repo-cloud-openclaw-slack",
    manifestName: "openclaw-nvidia-slack",
    environment: ubuntuRepoDocker("cloud-nvidia-openclaw-slack"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke", "messaging-slack"],
    requiredSecrets: ["NVIDIA_API_KEY", "SLACK_BOT_TOKEN"],
  },
  {
    id: "ubuntu-repo-cloud-hermes-discord",
    manifestName: "hermes-nvidia-discord",
    environment: ubuntuRepoDocker("cloud-nvidia-hermes-discord"),
    expectedStateId: "cloud-hermes-ready",
    suiteIds: ["smoke"],
    requiredSecrets: ["NVIDIA_API_KEY", "DISCORD_BOT_TOKEN"],
  },
  {
    id: "ubuntu-repo-cloud-hermes-slack",
    manifestName: "hermes-nvidia-slack",
    environment: ubuntuRepoDocker("cloud-nvidia-hermes-slack"),
    expectedStateId: "cloud-hermes-ready",
    suiteIds: ["smoke"],
    requiredSecrets: ["NVIDIA_API_KEY", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  },
  {
    id: "ubuntu-repo-cloud-openclaw-resume",
    manifestName: "openclaw-nvidia-resume",
    environment: ubuntuRepoDocker("cloud-nvidia-openclaw-resume-after-interrupt"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke"],
    requiredSecrets: ["NVIDIA_API_KEY"],
  },
  {
    id: "ubuntu-repo-cloud-openclaw-repair",
    manifestName: "openclaw-nvidia-repair",
    environment: ubuntuRepoDocker("cloud-nvidia-openclaw-repair-existing-config"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke"],
    requiredSecrets: ["NVIDIA_API_KEY"],
  },
  {
    id: "ubuntu-repo-cloud-openclaw-double-same-provider",
    manifestName: "openclaw-nvidia-double-same-provider",
    environment: ubuntuRepoDocker("cloud-nvidia-openclaw-double-same-provider"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke"],
    requiredSecrets: ["NVIDIA_API_KEY"],
  },
  {
    id: "ubuntu-repo-cloud-openclaw-double-provider-switch",
    manifestName: "openclaw-nvidia-double-provider-switch",
    environment: ubuntuRepoDocker("cloud-nvidia-openclaw-double-provider-switch"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke"],
    requiredSecrets: ["NVIDIA_API_KEY"],
  },
  {
    id: "ubuntu-repo-cloud-openclaw-token-rotation",
    manifestName: "openclaw-nvidia-token-rotation",
    environment: ubuntuRepoDocker("cloud-nvidia-openclaw-token-rotation"),
    expectedStateId: "cloud-openclaw-ready",
    suiteIds: ["smoke", "messaging-token-rotation"],
    requiredSecrets: ["NVIDIA_API_KEY"],
  },
  {
    id: "ubuntu-repo-cloud-openclaw-custom-policies",
    manifestName: "openclaw-nvidia-custom-policies",
    environment: ubuntuRepoDocker("cloud-openclaw-custom-policies"),
    expectedStateId: "cloud-openclaw-custom-policies-ready",
    suiteIds: ["smoke", "inference", "credentials", "onboarding-state", "baseline-onboarding", "model-router", "snapshot-lifecycle"],
    requiredSecrets: ["NVIDIA_API_KEY"],
  },
  {
    id: "ubuntu-invalid-nvidia-key-negative",
    manifestName: "openclaw-nvidia-invalid-key",
    environment: ubuntuRepoDocker("cloud-openclaw-invalid-nvidia-key"),
    expectedStateId: "onboarding-failure-invalid-nvidia-key",
    onboardingAssertionIds: ["base-installed"],
    suiteIds: [],
    requiredSecrets: ["NVIDIA_API_KEY"],
    expectedFailure: {
      phase: "onboarding",
      errorClass: "invalid-nvidia-api-key",
      forbiddenSideEffects: ["gateway-started", "sandbox-created"],
    },
  },
  {
    id: "ubuntu-gateway-port-conflict-negative",
    manifestName: "openclaw-nvidia-gateway-port-conflict",
    environment: ubuntuRepoDocker("cloud-openclaw-gateway-port-conflict"),
    expectedStateId: "onboarding-failure-gateway-port-conflict",
    onboardingAssertionIds: ["base-installed"],
    suiteIds: [],
    requiredSecrets: ["NVIDIA_API_KEY"],
    expectedFailure: {
      phase: "onboarding",
      errorClass: "gateway-port-conflict",
      forbiddenSideEffects: ["gateway-started", "sandbox-created"],
    },
  },
];

export function canonicalScenarios(): ScenarioDefinition[] {
  return canonicalScenarioInputs.map(canonicalScenario);
}

export function ubuntuRepoCloudOpenClawScenario(): ScenarioDefinition {
  const scenario = canonicalScenarios().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw");
  if (!scenario) {
    throw new Error("Missing canonical scenario 'ubuntu-repo-cloud-openclaw'");
  }
  return scenario;
}
