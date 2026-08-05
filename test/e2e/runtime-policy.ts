// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFreeStandingJobsInventory } from "../../tools/e2e/workflow-boundary.mts";
import { listTargets } from "./registry/registry.ts";

export type LiveE2ERuntimeTier = "pr" | "nightly" | "weekly" | "release";
export type LiveE2ERunnerClass =
  | "standard-linux"
  | "larger-linux"
  | "mixed-linux"
  | "gpu-linux"
  | "jetson-linux"
  | "macos"
  | "windows-wsl"
  | "remote-brev";
export type LiveE2ECoverageKind = "registry-target" | "workflow-target";
export type LiveE2ETelemetry =
  | "job-runtime"
  | "semantic-phase-progress"
  | "runner-pressure"
  | "runner-comparison";
export type LiveE2EArtifact = "target-evidence" | "runtime-summary" | "launchable-evidence";

export interface LiveE2EPolicyException {
  rationale: string;
  expiresOn: string;
  reviewCondition: string;
}

export interface LiveE2ERuntimePolicyEntry {
  id: string;
  kind: LiveE2ECoverageKind;
  uniqueBoundary: string;
  expectedRuntimeMinutes: number;
  budgetMinutes: number;
  expectedRunnerMinutes: number;
  runnerClass: LiveE2ERunnerClass;
  tier: LiveE2ERuntimeTier;
  owningFiles: string[];
  requiredTelemetry: LiveE2ETelemetry[];
  requiredArtifacts: LiveE2EArtifact[];
  reviewCondition: string;
  exception?: LiveE2EPolicyException;
}

export interface LiveE2ERuntimePolicy {
  apiVersion: "nemoclaw.io/v1";
  kind: "LiveE2ERuntimePolicy";
  baseline: {
    status: "provisional" | "measured";
    sourceRun: {
      runId: string;
      candidateSha: string;
      measuredOn: string;
      wallMinutes: number;
      runnerMinutes: number;
      nonSkippedJobs: number;
    };
    goals: {
      prWallMinutes: number;
      nightlyWallMinutes: number;
      nightlyRunnerMinutes: number;
      weeklyWallMinutes: number;
    };
    exception?: LiveE2EPolicyException;
  };
  coverage: LiveE2ERuntimePolicyEntry[];
}

type RuntimeSeed = readonly [
  tier: LiveE2ERuntimeTier,
  expectedRuntimeMinutes: number,
  budgetMinutes: number,
  expectedRunnerMinutes: number,
  runnerClass: LiveE2ERunnerClass,
];

const REGISTRY_RUNTIME = {
  "brev-launchable-cloud-openclaw": ["release", 60, 180, 60, "remote-brev"],
  "gpu-repo-local-ollama-openclaw": ["release", 20, 45, 20, "gpu-linux"],
  "macos-repo-cloud-openclaw": ["release", 15, 30, 15, "macos"],
  "ubuntu-gateway-port-conflict-negative": ["weekly", 8, 15, 8, "standard-linux"],
  "ubuntu-invalid-nvidia-key-negative": ["weekly", 8, 15, 8, "standard-linux"],
  "ubuntu-no-docker-preflight-negative": ["weekly", 5, 10, 5, "standard-linux"],
  "ubuntu-policy-custom-missing-presets-negative": ["weekly", 4, 10, 4, "standard-linux"],
  "ubuntu-rebuild-openclaw": ["weekly", 18, 30, 18, "standard-linux"],
  "ubuntu-repo-cloud-hermes": ["nightly", 8, 15, 8, "standard-linux"],
  "ubuntu-repo-cloud-hermes-discord": ["weekly", 10, 20, 10, "standard-linux"],
  "ubuntu-repo-cloud-hermes-slack": ["weekly", 10, 20, 10, "standard-linux"],
  "ubuntu-repo-cloud-langchain-deepagents-code": ["pr", 14, 15, 14, "standard-linux"],
  "ubuntu-repo-cloud-openclaw": ["nightly", 5, 10, 5, "standard-linux"],
  "ubuntu-repo-cloud-openclaw-brave": ["weekly", 8, 15, 8, "standard-linux"],
  "ubuntu-repo-cloud-openclaw-custom-policies": ["weekly", 15, 25, 15, "standard-linux"],
  "ubuntu-repo-cloud-openclaw-discord": ["weekly", 10, 20, 10, "standard-linux"],
  "ubuntu-repo-cloud-openclaw-double-provider-switch": ["weekly", 12, 20, 12, "standard-linux"],
  "ubuntu-repo-cloud-openclaw-double-same-provider": ["weekly", 12, 20, 12, "standard-linux"],
  "ubuntu-repo-cloud-openclaw-repair": ["weekly", 8, 15, 8, "standard-linux"],
  "ubuntu-repo-cloud-openclaw-resume": ["weekly", 8, 15, 8, "standard-linux"],
  "ubuntu-repo-cloud-openclaw-slack": ["weekly", 10, 20, 10, "standard-linux"],
  "ubuntu-repo-cloud-openclaw-telegram": ["weekly", 10, 20, 10, "standard-linux"],
  "ubuntu-repo-cloud-openclaw-token-rotation": ["weekly", 15, 25, 15, "standard-linux"],
  "ubuntu-repo-docker-post-reboot-recovery": ["pr", 5, 15, 5, "standard-linux"],
  "ubuntu-repo-openai-compatible-openclaw": ["weekly", 8, 15, 8, "standard-linux"],
  "wsl-repo-cloud-openclaw": ["release", 20, 45, 20, "windows-wsl"],
} as const satisfies Record<string, RuntimeSeed>;

const REGISTRY_BOUNDARIES: Record<keyof typeof REGISTRY_RUNTIME, string> = {
  "brev-launchable-cloud-openclaw":
    "A release candidate provisions and validates the exact remote Brev Launchable image.",
  "gpu-repo-local-ollama-openclaw":
    "OpenClaw reaches local Ollama through Docker CDI on a real NVIDIA GPU runner.",
  "macos-repo-cloud-openclaw":
    "The repository CLI installs and onboards on hosted macOS without assuming a Docker daemon.",
  "ubuntu-gateway-port-conflict-negative":
    "Onboarding fails without side effects when the OpenShell gateway port is already occupied.",
  "ubuntu-invalid-nvidia-key-negative":
    "Cloud onboarding rejects an invalid NVIDIA credential without creating runtime state.",
  "ubuntu-no-docker-preflight-negative":
    "Preflight rejects a Docker-less Ubuntu host before starting a gateway or sandbox.",
  "ubuntu-policy-custom-missing-presets-negative":
    "Custom policy onboarding rejects a missing preset selection at its live preflight boundary.",
  "ubuntu-rebuild-openclaw":
    "A live OpenClaw sandbox rebuild preserves its workspace and returns to a healthy state.",
  "ubuntu-repo-cloud-hermes":
    "A repository checkout onboards Hermes and completes a real hosted inference turn.",
  "ubuntu-repo-cloud-hermes-discord":
    "Hermes completes Discord onboarding against the real channel and sandbox boundary.",
  "ubuntu-repo-cloud-hermes-slack":
    "Hermes completes Slack socket-mode onboarding against the real channel boundary.",
  "ubuntu-repo-cloud-langchain-deepagents-code":
    "DeepAgents Code survives rebuild and invalid-credential lifecycle transitions in a real sandbox.",
  "ubuntu-repo-cloud-openclaw":
    "A repository checkout onboards OpenClaw and completes a real hosted inference turn.",
  "ubuntu-repo-cloud-openclaw-brave":
    "OpenClaw uses the live Brave search integration through the sandbox network policy.",
  "ubuntu-repo-cloud-openclaw-custom-policies":
    "OpenClaw onboards with a custom policy and proves router, credential, snapshot, and state seams.",
  "ubuntu-repo-cloud-openclaw-discord":
    "OpenClaw completes Discord onboarding against the real channel and sandbox boundary.",
  "ubuntu-repo-cloud-openclaw-double-provider-switch":
    "A live OpenClaw sandbox remains healthy across two onboarding passes that switch providers.",
  "ubuntu-repo-cloud-openclaw-double-same-provider":
    "A live OpenClaw sandbox remains idempotent across two onboarding passes for one provider.",
  "ubuntu-repo-cloud-openclaw-repair":
    "OpenClaw repairs an existing live configuration without losing the sandbox state.",
  "ubuntu-repo-cloud-openclaw-resume":
    "Interrupted OpenClaw onboarding resumes against the existing live runtime state.",
  "ubuntu-repo-cloud-openclaw-slack":
    "OpenClaw completes Slack onboarding against the real channel and sandbox boundary.",
  "ubuntu-repo-cloud-openclaw-telegram":
    "OpenClaw completes Telegram onboarding against the real channel and sandbox boundary.",
  "ubuntu-repo-cloud-openclaw-token-rotation":
    "A live OpenClaw sandbox accepts a rotated provider credential without stale-token reuse.",
  "ubuntu-repo-docker-post-reboot-recovery":
    "Gateway restart recovery preserves the host registry and labeled sandbox container.",
  "ubuntu-repo-openai-compatible-openclaw":
    "OpenClaw reaches an external OpenAI-compatible endpoint through the live sandbox boundary.",
  "wsl-repo-cloud-openclaw":
    "The repository CLI onboards OpenClaw through Docker inside a real hosted WSL2 environment.",
};

const WORKFLOW_RUNTIME = {
  "agent-turn-latency": ["weekly", 9, 15, 9, "standard-linux"],
  "bedrock-runtime-compatible-anthropic": ["weekly", 5, 15, 9, "mixed-linux"],
  "bootstrap-install-smoke": ["nightly", 5, 10, 5, "standard-linux"],
  "brave-search": ["weekly", 1, 10, 1, "standard-linux"],
  "channels-add-remove": ["weekly", 9, 20, 9, "standard-linux"],
  "channels-stop-start": ["weekly", 16, 25, 25, "mixed-linux"],
  "cloud-inference": ["nightly", 5, 10, 5, "standard-linux"],
  "cloud-onboard": ["nightly", 6, 15, 6, "standard-linux"],
  "common-egress-agent": ["nightly", 5, 15, 9, "larger-linux"],
  "concurrent-gateway-ports": ["weekly", 6, 15, 6, "standard-linux"],
  "cron-preflight-inference-local": ["weekly", 6, 15, 6, "standard-linux"],
  "dashboard-remote-bind": ["weekly", 7, 15, 7, "standard-linux"],
  "device-auth-health": ["weekly", 6, 15, 6, "standard-linux"],
  "double-onboard": ["weekly", 9, 20, 9, "standard-linux"],
  "full-e2e": ["weekly", 5, 15, 5, "standard-linux"],
  "gateway-guard-recovery": ["nightly", 7, 15, 7, "standard-linux"],
  "gpu-double-onboard": ["release", 7, 30, 7, "gpu-linux"],
  "gpu-e2e": ["release", 7, 30, 7, "gpu-linux"],
  "hermes-discord": ["weekly", 5, 15, 5, "larger-linux"],
  "hermes-e2e": ["nightly", 7, 15, 7, "larger-linux"],
  "hermes-gpu-startup": ["release", 20, 45, 20, "gpu-linux"],
  "hermes-inference-switch": ["weekly", 5, 15, 10, "larger-linux"],
  "hermes-shields-config": ["weekly", 5, 15, 5, "larger-linux"],
  "hermes-slack": ["weekly", 4, 15, 4, "larger-linux"],
  "inference-routing": ["weekly", 9, 15, 9, "standard-linux"],
  "issue-2478-crash-loop-recovery": ["weekly", 14, 25, 14, "standard-linux"],
  "issue-4434-tui-unreachable-inference": ["weekly", 1, 10, 1, "standard-linux"],
  "issue-4462-scope-upgrade-approval": ["weekly", 7, 15, 7, "standard-linux"],
  "jetson-nvmap-gpu": ["release", 20, 45, 20, "jetson-linux"],
  "kimi-inference-compat": ["weekly", 4, 15, 4, "standard-linux"],
  "llama-cpp-dgx-spark-qualification": ["release", 120, 180, 120, "gpu-linux"],
  "mcp-bridge": ["weekly", 24, 30, 41, "mixed-linux"],
  "mcp-bridge-dev": ["weekly", 15, 30, 30, "standard-linux"],
  "managed-image-multiarch-startup": ["release", 15, 30, 30, "mixed-linux"],
  "managed-image-protected-runtime": ["release", 120, 180, 120, "gpu-linux"],
  "messaging-compatible-endpoint": ["nightly", 6, 15, 6, "standard-linux"],
  "messaging-providers": ["weekly", 13, 25, 13, "standard-linux"],
  "model-router-provider-routed-inference": ["weekly", 7, 15, 7, "standard-linux"],
  "network-policy": ["nightly", 7, 15, 7, "standard-linux"],
  "ollama-auth-proxy": ["weekly", 2, 10, 2, "standard-linux"],
  "onboard-repair": ["weekly", 5, 15, 5, "standard-linux"],
  "onboard-resume": ["weekly", 7, 15, 7, "standard-linux"],
  "openclaw-discord-pairing": ["weekly", 6, 15, 6, "standard-linux"],
  "openclaw-inference-switch": ["weekly", 6, 15, 12, "standard-linux"],
  "openclaw-plugin-runtime-exdev": ["weekly", 27, 45, 27, "standard-linux"],
  "openclaw-plugin-runtime-exdev-release": ["release", 10, 30, 10, "standard-linux"],
  "openclaw-skill-cli": ["weekly", 5, 15, 5, "standard-linux"],
  "openclaw-slack-pairing": ["weekly", 7, 15, 7, "standard-linux"],
  "openclaw-tui-chat-correlation": ["nightly", 6, 15, 6, "standard-linux"],
  "openshell-credential-generation-window": ["weekly", 15, 30, 15, "standard-linux"],
  "openshell-gateway-auth-contract": ["weekly", 10, 20, 10, "standard-linux"],
  "openshell-gateway-upgrade": ["weekly", 29, 45, 66, "mixed-linux"],
  "overlayfs-autofix": ["weekly", 1, 10, 1, "standard-linux"],
  "rebuild-hermes": ["weekly", 6, 15, 6, "larger-linux"],
  "rebuild-hermes-stale-base": ["weekly", 6, 15, 6, "larger-linux"],
  "rebuild-openclaw": ["weekly", 20, 30, 20, "standard-linux"],
  "sandbox-operations": ["weekly", 8, 15, 8, "standard-linux"],
  "sandbox-survival": ["weekly", 6, 15, 6, "standard-linux"],
  "security-posture": ["nightly", 6, 15, 12, "mixed-linux"],
  "sessions-agents-cli": ["weekly", 6, 15, 6, "standard-linux"],
  "shields-config": ["weekly", 7, 15, 7, "standard-linux"],
  "skill-agent": ["weekly", 5, 15, 5, "standard-linux"],
  "snapshot-commands": ["weekly", 9, 15, 9, "standard-linux"],
  "spark-install": ["weekly", 5, 15, 5, "standard-linux"],
  "staging-brev-launchable": ["release", 60, 180, 60, "remote-brev"],
  "state-backup-restore": ["weekly", 6, 15, 6, "standard-linux"],
  "telegram-injection": ["weekly", 9, 15, 9, "standard-linux"],
  "token-rotation": ["nightly", 19, 20, 19, "standard-linux"],
  "tunnel-lifecycle": ["weekly", 6, 15, 6, "standard-linux"],
  "vllm-docker-storage": ["weekly", 1, 10, 1, "standard-linux"],
} as const satisfies Record<string, RuntimeSeed>;

const WORKFLOW_BOUNDARIES: Record<keyof typeof WORKFLOW_RUNTIME, string> = {
  "agent-turn-latency":
    "A real agent turn remains within the retained end-to-end latency envelope.",
  "bedrock-runtime-compatible-anthropic":
    "OpenAI-compatible Anthropic traffic crosses the live Bedrock adapter boundary.",
  "bootstrap-install-smoke":
    "The published bootstrap installer produces a runnable CLI on a clean hosted runner.",
  "brave-search": "A sandboxed OpenClaw agent reaches the live Brave search integration.",
  "channels-add-remove":
    "Live channel configuration survives add and remove lifecycle transitions.",
  "channels-stop-start":
    "OpenClaw and Hermes channel processes stop and restart without losing channel state.",
  "cloud-inference": "The sandboxed agent completes a real NVIDIA-hosted inference request.",
  "cloud-onboard": "Cloud onboarding creates a healthy gateway and sandbox from a clean host.",
  "common-egress-agent":
    "Representative OpenClaw and Hermes agents reach only the shared reviewed egress destinations.",
  "concurrent-gateway-ports":
    "Two live gateway instances allocate isolated ports without collision.",
  "cron-preflight-inference-local":
    "Cron-style preflight preserves the local inference route in a noninteractive process.",
  "dashboard-remote-bind": "The dashboard honors its reviewed remote-bind network boundary.",
  "device-auth-health":
    "Device authentication remains healthy across the live gateway and provider seams.",
  "double-onboard": "Two live onboarding passes remain idempotent against one sandbox.",
  "full-e2e":
    "The canonical OpenClaw live journey covers install, onboard, inference, and cleanup.",
  "gateway-guard-recovery":
    "The gateway guard recovers a failed live gateway without corrupting state.",
  "gpu-double-onboard": "Two onboarding passes remain idempotent on a real NVIDIA GPU runner.",
  "gpu-e2e": "The canonical GPU journey reaches a containerized model through Docker CDI.",
  "hermes-discord": "Hermes sends and receives through the real Discord channel boundary.",
  "hermes-e2e": "The canonical Hermes live journey covers onboard, inference, and cleanup.",
  "hermes-gpu-startup": "Hermes starts against a real GPU-backed local inference runtime.",
  "hermes-inference-switch":
    "Hermes switches live inference protocols without stale provider state.",
  "hermes-shields-config":
    "Hermes applies the reviewed Shields configuration inside a live sandbox.",
  "hermes-slack": "Hermes establishes a real Slack socket-mode channel session.",
  "inference-routing": "The live router selects the configured inference provider and model route.",
  "issue-2478-crash-loop-recovery":
    "A repeatedly crashing sandbox reaches the retained recovery state.",
  "issue-4434-tui-unreachable-inference":
    "The TUI reports unreachable inference without hanging the live process.",
  "issue-4462-scope-upgrade-approval":
    "A live scope upgrade requires and records the expected approval transition.",
  "jetson-nvmap-gpu":
    "A Jetson runner exposes the required nvmap GPU device boundary to the sandbox.",
  "kimi-inference-compat": "The Kimi-compatible provider completes a real inference turn.",
  "llama-cpp-dgx-spark-qualification":
    "The exact managed llama.cpp image proves authenticated GPU-offloaded inference and cleanup on NVIDIA DGX Spark.",
  "mcp-bridge": "DeepAgents, OpenClaw, and Hermes cross the retained MCP bridge process boundary.",
  "mcp-bridge-dev": "The development MCP bridge path connects all supported agents from source.",
  "managed-image-multiarch-startup":
    "Exact managed images for every supported agent start directly on native AMD64 and ARM64 runners.",
  "managed-image-protected-runtime":
    "Exact managed images retain GPU, Ollama, NIM, vLLM, rollback, and cleanup behavior on a protected runner.",
  "messaging-compatible-endpoint":
    "A live channel reaches a compatible external messaging endpoint through policy.",
  "messaging-providers":
    "Provider-specific messaging adapters complete their live delivery contracts.",
  "model-router-provider-routed-inference":
    "The model router reaches the provider selected by the live route contract.",
  "network-policy":
    "Live probes prove allowed egress and denied destinations in the sandbox policy.",
  "ollama-auth-proxy": "The Ollama authentication proxy mediates a real local inference request.",
  "onboard-repair": "Onboarding repairs an existing configuration without replacing healthy state.",
  "onboard-resume": "Interrupted onboarding resumes from the persisted live checkpoint.",
  "openclaw-discord-pairing": "OpenClaw completes the real Discord pairing handshake.",
  "openclaw-inference-switch":
    "OpenClaw switches live inference protocols without stale provider state.",
  "openclaw-plugin-runtime-exdev":
    "The OpenClaw plugin loads across a real cross-device runtime dependency boundary.",
  "openclaw-plugin-runtime-exdev-release":
    "The release-baseline OpenClaw package loads across the retained EXDEV boundary.",
  "openclaw-skill-cli":
    "The OpenClaw skill invokes the installed NemoClaw CLI inside a live sandbox.",
  "openclaw-slack-pairing": "OpenClaw completes the real Slack pairing handshake.",
  "openclaw-tui-chat-correlation":
    "The OpenClaw TUI preserves one chat correlation identity through the live gateway.",
  "openshell-credential-generation-window":
    "Parallel OpenShell credential generation remains isolated inside the retained race window.",
  "openshell-gateway-auth-contract":
    "The installed OpenShell gateway authenticates only through the reviewed source contract.",
  "openshell-gateway-upgrade":
    "Supported historical OpenShell gateways upgrade through the current live migration boundary.",
  "overlayfs-autofix":
    "A live overlayfs incompatibility is detected and repaired before sandbox startup.",
  "rebuild-hermes": "A current Hermes sandbox rebuild preserves live state and returns healthy.",
  "rebuild-hermes-stale-base":
    "A Hermes sandbox rebuild replaces a retained stale base without losing live state.",
  "rebuild-openclaw": "A historical OpenClaw base rebuilds into the current healthy sandbox state.",
  "sandbox-operations": "Start, stop, status, and remove commands act on a real sandbox lifecycle.",
  "sandbox-survival": "A sandbox remains recoverable after the live gateway process is replaced.",
  "security-posture":
    "OpenClaw and Hermes retain the required container and process security posture.",
  "sessions-agents-cli": "Session and agent CLI commands reflect the live gateway state.",
  "shields-config": "OpenClaw applies the reviewed Shields configuration inside a live sandbox.",
  "skill-agent": "A packaged skill executes through the live agent and sandbox boundary.",
  "snapshot-commands": "Snapshot create, list, and restore commands preserve live sandbox state.",
  "spark-install": "The Spark installation path produces a runnable sandbox on a clean host.",
  "staging-brev-launchable": "The exact release candidate launches and validates on staging Brev.",
  "state-backup-restore":
    "A live state backup restores the gateway and sandbox to the expected state.",
  "telegram-injection": "A forged Telegram update is rejected at the live channel trust boundary.",
  "token-rotation": "A live sandbox adopts a rotated credential and rejects the stale token.",
  "tunnel-lifecycle":
    "The external tunnel starts, serves, and shuts down with the sandbox lifecycle.",
  "vllm-docker-storage":
    "A vLLM container preserves model storage across the Docker runtime boundary.",
};

const POLICY_EXCEPTIONS: Partial<Record<keyof typeof WORKFLOW_RUNTIME, LiveE2EPolicyException>> = {
  "llama-cpp-dgx-spark-qualification": {
    rationale:
      "This protected release lane does not yet have five comparable passing runtime samples.",
    expiresOn: "2026-08-31",
    reviewCondition:
      "Replace the provisional runtime values after five comparable passing protected qualification runs.",
  },
  "managed-image-multiarch-startup": {
    rationale:
      "This protected release lane does not yet have five comparable passing runtime samples.",
    expiresOn: "2026-08-31",
    reviewCondition:
      "Replace the provisional runtime values after five comparable passing multiarch startup runs.",
  },
  "managed-image-protected-runtime": {
    rationale:
      "This protected release lane does not yet have five comparable passing runtime samples.",
    expiresOn: "2026-08-31",
    reviewCondition:
      "Replace the provisional runtime values after five comparable passing protected runtime runs.",
  },
};

const DEFAULT_TELEMETRY: LiveE2ETelemetry[] = ["semantic-phase-progress", "job-runtime"];
const DEFAULT_ARTIFACTS: LiveE2EArtifact[] = ["target-evidence", "runtime-summary"];
const REGISTRY_TARGETS = listTargets();
const WORKFLOW_INVENTORY = readFreeStandingJobsInventory();

function reviewCondition(tier: LiveE2ERuntimeTier): string {
  return `Review after five ${tier} samples; consolidate or retire this item if another check proves the same live boundary.`;
}

function registryOwningFiles(id: string): string[] {
  const target = REGISTRY_TARGETS.find((candidate) => candidate.id === id);
  if (!target?.manifestPath) return ["test/e2e/registry/definitions/baseline.ts"];
  return ["test/e2e/registry/definitions/baseline.ts", target.manifestPath];
}

function workflowOwningFiles(id: string): string[] {
  if (id === "staging-brev-launchable") return ["tools/e2e/brev-launchable-e2e.sh"];
  return [...WORKFLOW_INVENTORY.liveTestToJobs]
    .filter(([, targetIds]) => targetIds.includes(id))
    .map(([file]) => file);
}

function entry(
  id: string,
  kind: LiveE2ECoverageKind,
  seed: RuntimeSeed,
  uniqueBoundary: string,
): LiveE2ERuntimePolicyEntry {
  const [tier, expectedRuntimeMinutes, budgetMinutes, expectedRunnerMinutes, runnerClass] = seed;
  const launchable = id === "staging-brev-launchable";
  return {
    id,
    kind,
    uniqueBoundary,
    expectedRuntimeMinutes,
    budgetMinutes,
    expectedRunnerMinutes,
    runnerClass,
    tier,
    owningFiles: kind === "registry-target" ? registryOwningFiles(id) : workflowOwningFiles(id),
    requiredTelemetry: launchable ? ["job-runtime"] : [...DEFAULT_TELEMETRY],
    requiredArtifacts: launchable
      ? ["launchable-evidence", "runtime-summary"]
      : [...DEFAULT_ARTIFACTS],
    reviewCondition: reviewCondition(tier),
    ...(kind === "workflow-target" && POLICY_EXCEPTIONS[id as keyof typeof WORKFLOW_RUNTIME]
      ? { exception: POLICY_EXCEPTIONS[id as keyof typeof WORKFLOW_RUNTIME] }
      : {}),
  };
}

export const LIVE_E2E_RUNTIME_POLICY: LiveE2ERuntimePolicy = {
  apiVersion: "nemoclaw.io/v1",
  kind: "LiveE2ERuntimePolicy",
  baseline: {
    status: "provisional",
    sourceRun: {
      runId: "30503498077",
      candidateSha: "d52d4599a18490e7f8efc6e8062296fffcbea4a7",
      measuredOn: "2026-07-30",
      wallMinutes: 29.62,
      runnerMinutes: 592.5,
      nonSkippedJobs: 83,
    },
    goals: {
      prWallMinutes: 15,
      nightlyWallMinutes: 20,
      nightlyRunnerMinutes: 299,
      weeklyWallMinutes: 45,
    },
    exception: {
      rationale:
        "The source run predates the merged #7665 retirements and #7943 exact-commit artifact optimization.",
      expiresOn: "2026-08-31",
      reviewCondition:
        "Replace the source run with five comparable passing runs from the current retained inventory.",
    },
  },
  coverage: [
    ...Object.entries(REGISTRY_RUNTIME).map(([id, seed]) =>
      entry(id, "registry-target", seed, REGISTRY_BOUNDARIES[id as keyof typeof REGISTRY_RUNTIME]),
    ),
    ...Object.entries(WORKFLOW_RUNTIME).map(([id, seed]) =>
      entry(id, "workflow-target", seed, WORKFLOW_BOUNDARIES[id as keyof typeof WORKFLOW_RUNTIME]),
    ),
  ].sort((left, right) => left.id.localeCompare(right.id)),
};
