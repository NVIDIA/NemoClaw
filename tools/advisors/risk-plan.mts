// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  LLAMA_CPP_DGX_SPARK_AGENT_QUALIFICATION_PATH,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH,
} from "../../scripts/checks/llama-cpp-dgx-spark-qualification-paths.mts";
import * as importedProtectedManagedImageContract from "../../scripts/checks/protected-managed-image-contract.ts";

// The root TypeScript package is exposed as CJS under the exact
// `node --import tsx` workflow execution mode, but as an ESM namespace under
// Vitest. Normalize both representations before reading shared identifiers.
const protectedManagedImageContract = (
  "default" in importedProtectedManagedImageContract &&
  importedProtectedManagedImageContract.default
    ? importedProtectedManagedImageContract.default
    : importedProtectedManagedImageContract
) as typeof import("../../scripts/checks/protected-managed-image-contract.ts");

const { PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH, PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID } =
  protectedManagedImageContract;

export const RISK_PLAN_VERSION = 21 as const;

export const PR_E2E_TYPED_TARGET_IDS = [
  "ubuntu-repo-cloud-langchain-deepagents-code",
  "ubuntu-repo-docker-post-reboot-recovery",
] as const;

const PR_E2E_TYPED_TARGET_ID_SET = new Set<string>(PR_E2E_TYPED_TARGET_IDS);
const PR_E2E_PLANNING_OMITTED_JOB_IDS = new Set(["jetson-nvmap-gpu"]);
export const PR_E2E_MANUAL_CONTROLLER_JOB_IDS = [
  "inference-routing",
  "managed-image-protected-runtime",
] as const;
const PR_E2E_MANUAL_CONTROLLER_JOB_ID_SET = new Set<string>(PR_E2E_MANUAL_CONTROLLER_JOB_IDS);
const DEEPAGENTS_HEADLESS_INFERENCE_CHECK =
  "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh";
const DEEPAGENTS_CODE_RUNTIME_ROOT = "agents/langchain-deepagents-code/";
const JOURNALED_RECREATE_RESUME_RUNTIME_FILES = new Set([
  "src/lib/onboard/machine/handlers/sandbox-resume.ts",
  "src/lib/onboard/machine/handlers/sandbox.ts",
]);
const POST_REBOOT_DELIVERY_RUNTIME_FILES = new Set([
  "src/lib/actions/sandbox/status-snapshot.ts",
  "src/lib/onboard/docker-driver-sandbox-recovery.ts",
  "src/lib/onboard/docker-startup-command-agent.ts",
  "src/lib/onboard/sandbox-create-step.ts",
  "tools/e2e/onboard-timeout-contract.mts",
]);
export const GATEWAY_TOPOLOGY_FILES = [
  "src/lib/core/gateway-address.ts",
  "src/lib/onboard/docker-driver-gateway-config.ts",
  "src/lib/onboard/docker-driver-gateway-env.ts",
  "src/lib/onboard/docker-driver-gateway-local-tls.ts",
  "src/lib/onboard/docker-driver-platform.ts",
  "src/lib/onboard/experimental/docker-network-authority.ts",
  "src/lib/onboard/experimental/hermes-portable-ollama-authority.ts",
  "src/lib/onboard/experimental/portable-host-preparation.ts",
  "src/lib/onboard/experimental/portable-profile.ts",
  "src/lib/onboard/gateway-host-runtime.ts",
  "src/lib/onboard/gateway-http-readiness.ts",
  "src/lib/onboard/gateway-recovery.ts",
  "src/lib/onboard/gateway-sandbox-reachability.ts",
  "src/lib/onboard/gateway-tcp-readiness.ts",
  "src/lib/onboard/host-service-reachability.ts",
  "src/lib/onboard/runtime-provider/contract.ts",
  "src/lib/onboard/runtime-provider/podman-host-local-inference.ts",
] as const;
const GATEWAY_TOPOLOGY_FILE_SET = new Set<string>(GATEWAY_TOPOLOGY_FILES);
const MANAGED_STARTUP_E2E_JOB_IDS = [
  "device-auth-health",
  "issue-4462-scope-upgrade-approval",
  "openclaw-inference-switch",
] as const;
const HERMES_CLI_ADAPTER_E2E_JOB_IDS = ["channels-stop-start", "mcp-bridge"] as const;
const HERMES_CLI_ADAPTER_RUNTIME_FILES = new Set([
  "agents/hermes/hermes-cli-adapter-v1.json",
  "agents/hermes/hermes-wrapper.py",
  "agents/hermes/validate-cli-adapter.py",
]);
const HERMES_CRON_RESTORE_E2E_JOB_IDS = ["rebuild-hermes"] as const;
const HERMES_CRON_RESTORE_RUNTIME_FILES = new Set([
  "agents/hermes/cron-restore-control.py",
  "agents/hermes/patch-cron-restore-drain.py",
  "src/lib/actions/sandbox/rebuild-hermes-post-restore.ts",
  "src/lib/actions/sandbox/runtime/hermes-cron-restore-recovery.ts",
]);
const HERMES_MANAGED_POLICY_E2E_JOB_IDS = [
  "bedrock-runtime-compatible-anthropic",
  "channels-stop-start",
  "dashboard-remote-bind",
  "hermes-e2e",
  "hermes-inference-switch",
  "security-posture",
] as const;
const HERMES_MANAGED_POLICY_FILES = new Set([
  "agents/hermes/hermes-wrapper.py",
  "agents/hermes/image-build-probes.py",
  "agents/hermes/managed_policy.py",
  "agents/hermes/patch-profile-policy-defaults.py",
  "agents/hermes/seed-dashboard-config.py",
  "agents/hermes/start.sh",
  "src/lib/hermes-managed-route.ts",
]);
const SHARED_MESSAGING_RUNTIME_E2E_JOB_IDS = [
  "channels-add-remove",
  "channels-stop-start",
  "hermes-discord",
  "messaging-providers",
  "openclaw-discord-pairing",
  "openclaw-slack-pairing",
] as const;
const HERMES_MESSAGING_RUNTIME_E2E_JOB_IDS = [
  "channels-stop-start",
  "hermes-discord",
  "messaging-providers",
] as const;
const OPENCLAW_MESSAGING_RUNTIME_E2E_JOB_IDS = [
  "channels-stop-start",
  "messaging-providers",
  "openclaw-discord-pairing",
  "openclaw-slack-pairing",
] as const;
const MESSAGING_RUNTIME_FILES = new Set([
  "src/lib/actions/sandbox/rebuild-backup-phase.ts",
  "src/lib/actions/sandbox/rebuild-target-runtime.ts",
  "src/lib/onboard/credential-provider-registration.ts",
  "src/lib/onboard/extra-placeholder-keys.ts",
  "src/lib/onboard/gateway-provider-metadata.ts",
  "src/lib/onboard/messaging-policy-presets.ts",
  "src/lib/onboard/messaging-prep.ts",
  "src/lib/onboard/policy-preset-reconciliation.ts",
  "src/lib/onboard/policy-selection.ts",
  "src/lib/onboard/providers.ts",
  "src/lib/onboard/sandbox-create-plan-materialization.ts",
  "src/lib/onboard/sandbox-create/provider-publication.ts",
  "src/lib/onboard/sandbox-messaging-preflight.ts",
]);
const MESSAGING_RUNTIME_PREFIXES = [
  "src/lib/actions/sandbox/policy-channel",
  "src/lib/messaging/",
] as const;
const HERMES_STARTUP_RUNTIME_FILES = new Set([
  "agents/hermes/runtime-config-guard.py",
  "agents/hermes/start.sh",
]);
const OPENCLAW_STARTUP_RUNTIME_FILES = new Set(["scripts/nemoclaw-start.sh"]);
const MANAGED_IMAGE_PROTECTED_RUNTIME_ACTIVATION =
  "ci/protected-managed-image-runtime-activation-v1.json";
const MANAGED_IMAGE_PROTECTED_RUNTIME_JOB_ID = "managed-image-protected-runtime" as const;
const MANAGED_IMAGE_PROTECTED_RUNTIME_INPUTS = new Set([
  MANAGED_IMAGE_PROTECTED_RUNTIME_ACTIVATION,
  "src/lib/onboard.ts",
  "src/lib/onboard/sandbox-create-intent-types.ts",
  "src/lib/onboard/sandbox-create-plan-materialization.ts",
  "src/lib/onboard/sandbox-create-plan.ts",
  "src/lib/onboard/sandbox-registration.ts",
]);
const MANAGED_IMAGE_PROTECTED_RUNTIME_INPUT_PREFIXES = [
  "scripts/checks/run-managed-image-openshell-e2e.",
  "src/lib/actions/sandbox/rebuild-",
  "src/lib/onboard/managed-bootstrap/",
  "src/lib/onboard/managed-workload/",
  "src/lib/onboard/runtime-provider/",
  "src/lib/onboard/workload/",
  "test/e2e/live/managed-image-protected-runtime.",
] as const;
const LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID = "llama-cpp-dgx-spark-qualification" as const;
// The activation-only phase is complete. Any input that can change bytes or
// startup policy in a shipped managed image must requalify the exact all-agent
// amd64/arm64 cohort; the positive and adjacent-path cases in
// test/automation/pull-requests/pr-risk-plan.test.ts keep this inventory intentional and bounded.
const MANAGED_IMAGE_MULTIARCH_INPUTS = new Set([
  PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH,
  ".dockerignore",
  ".github/workflows/managed-images.yaml",
  "Dockerfile",
  "ci/npm-audit-exceptions.json",
  "src/lib/core/json-types.ts",
  "src/lib/core/ports.ts",
  "src/lib/onboard/managed-bootstrap/envelope.ts",
  "src/lib/security/credential-hash.ts",
  "src/lib/state/paths.ts",
  "src/lib/state/state-root.ts",
  "src/lib/tool-disclosure.ts",
  "tsconfig.runtime-preloads.json",
]);
const MANAGED_IMAGE_MULTIARCH_CHILD_CREDENTIALS =
  /^src\/lib\/actions\/sandbox\/openshell-child-visible-credentials[.]v[^/]+[.]json$/u;
const MANAGED_IMAGE_MULTIARCH_INPUT_PREFIXES = [
  "agents/",
  "nemoclaw/",
  "nemoclaw-blueprint/",
  "scripts/",
  "src/lib/actions/sandbox/mcp-bridge-",
  "src/lib/messaging/",
  "src/lib/onboard/managed-startup/",
  "tools/mcp-tool-discovery-runtime/",
] as const;

export type RiskTier = 0 | 1 | 2 | 3;
export type RiskFamilyId =
  | "lifecycle-state"
  | "gateway-topology"
  | "upgrade-rebuild"
  | "shared-agent"
  | "inference-policy"
  | "messaging-lifecycle"
  | "platform-install"
  | "openclaw-image"
  | "credentials-security"
  | "e2e-control-plane"
  | "managed-image-multiarch"
  | typeof MANAGED_IMAGE_PROTECTED_RUNTIME_JOB_ID
  | typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID
  | "sandbox-boundary"
  | "focused-e2e";

export type TrustedFocusedE2eJob = {
  id: string;
  matchedFiles: readonly string[];
};

export type TrustedFocusedE2eTarget = {
  id: string;
  matchedFiles: readonly string[];
};

export type RiskPlanFamily = {
  id: RiskFamilyId;
  summary: string;
  tier: Exclude<RiskTier, 0>;
  matchedFiles: string[];
  invariants: string[];
  requiredJobs: string[];
  requiredTargets: string[];
};

export type RiskPlanJob = {
  id: string;
  tier: Exclude<RiskTier, 0>;
  families: RiskFamilyId[];
  reasons: string[];
  matchedFiles: string[];
};

export type RiskPlanTarget = RiskPlanJob;

export type RiskPlan = {
  version: typeof RISK_PLAN_VERSION;
  headSha: string;
  planHash: string;
  changedFiles: string[];
  tier: RiskTier;
  families: RiskPlanFamily[];
  requiredJobs: RiskPlanJob[];
  requiredTargets: RiskPlanTarget[];
};

type RiskRule = Omit<RiskPlanFamily, "matchedFiles" | "requiredTargets"> & {
  matches(file: string): boolean;
};

const STATEFUL_SANDBOX_FILE = /^src\/lib\/actions\/sandbox\/.*\.ts$/;
const MUTATION_FILE = /(?:upgrade|rebuild|snapshot|backup|restore)/;
const INSTALL_SCRIPT = /^(?:install\.sh|scripts\/(?:install|setup|dev-setup)[^/]*\.(?:sh|js|ts))$/;
const INFERENCE_POLICY_FILE = /(?:^|[/.-])(?:inference|network-policy)(?:[/.-]|$)/;
const CREDENTIAL_SECURITY_FILE =
  /(?:^|[/.-])(?:credential|credentials|secret|secrets|redact|redaction|ssrf|security)(?:[/.-]|$)/i;
const E2E_CONTROL_PLANE_FILES = new Set([
  ".github/workflows/e2e.yaml",
  ".github/workflows/pr.yaml",
  "package-lock.json",
  "package.json",
  "scripts/scorecard/coordinate-scorecard.mts",
  "tools/advisors/github.mts",
  "tools/advisors/io.mts",
  "tools/advisors/risk-plan.mts",
  "vitest.config.ts",
]);
// These checked-in paths and directories are the source boundary for private-network
// and policy enforcement but are not all covered by the token heuristics above.
// Keep the explicit floor until a machine-readable security-owner catalog replaces it.
const PRIVATE_NETWORK_BOUNDARY_FILES = new Set([
  "nemoclaw-blueprint/private-networks.yaml",
  "nemoclaw/src/blueprint/private-networks.ts",
]);
const POLICY_SECURITY_FILE = /^src\/lib\/policy\//;
// Ordinary tests do not raise the runtime floor. These files either define a live
// platform contract or produce the evidence consumed by the trusted PR gate.
const RISK_RELEVANT_TEST_FILES = new Set([
  "test/e2e/live/cloud-onboard.test.ts",
  "test/e2e/risk-signal-reporter.ts",
]);
const E2E_SUPPORT_FILE = /^test\/e2e\/support\//;
const FOCUSED_E2E_SUMMARY =
  "Changed runtime surfaces and workflow-wired E2E tests must execute through their trusted canonical jobs or typed targets.";
const FOCUSED_E2E_INVARIANTS = [
  "the selected job or typed target exercises the changed runtime surface or test",
  "the canonical execution path runs the required coverage rather than treating it as advisory",
] as const;

export function isPrE2eTypedTargetId(value: string): boolean {
  return PR_E2E_TYPED_TARGET_ID_SET.has(value);
}

export function isPrE2ePlanningJob(value: string): boolean {
  // Automatic PR planning cannot attest the operator-owned Jetson backend and hardware path.
  // Remove this exclusion after that hardware gate produces trusted planning evidence.
  return !PR_E2E_PLANNING_OMITTED_JOB_IDS.has(value);
}

export function isPrE2eManualControllerJob(value: string): boolean {
  return PR_E2E_MANUAL_CONTROLLER_JOB_ID_SET.has(value);
}

export function focusedPrE2eTargetsForChangedFiles(
  changedFiles: readonly string[],
): TrustedFocusedE2eTarget[] {
  const deepAgentsMatchedFiles = stableUnique(
    changedFiles.filter(
      (file) =>
        file === DEEPAGENTS_HEADLESS_INFERENCE_CHECK ||
        JOURNALED_RECREATE_RESUME_RUNTIME_FILES.has(file) ||
        (file.startsWith(DEEPAGENTS_CODE_RUNTIME_ROOT) && isRuntimeRelevant(file)),
    ),
  );
  const postRebootMatchedFiles = stableUnique(
    changedFiles.filter((file) => POST_REBOOT_DELIVERY_RUNTIME_FILES.has(file)),
  );
  return [
    ...(deepAgentsMatchedFiles.length > 0
      ? [
          {
            id: PR_E2E_TYPED_TARGET_IDS[0],
            matchedFiles: deepAgentsMatchedFiles,
          },
        ]
      : []),
    ...(postRebootMatchedFiles.length > 0
      ? [
          {
            id: PR_E2E_TYPED_TARGET_IDS[1],
            matchedFiles: postRebootMatchedFiles,
          },
        ]
      : []),
  ];
}

export function focusedPrE2eJobsForChangedFiles(
  changedFiles: readonly string[],
): TrustedFocusedE2eJob[] {
  const journaledRecreateResumeFiles = stableUnique(
    changedFiles.filter((file) => JOURNALED_RECREATE_RESUME_RUNTIME_FILES.has(file)),
  );
  const managedStartupFiles = stableUnique(
    changedFiles.filter(
      (file) =>
        (file.startsWith("src/lib/onboard/managed-startup/") ||
          file === "src/lib/onboard/sandbox-create-launch.ts" ||
          file === "scripts/lib/entrypoint-env-wrapper.sh") &&
        isRuntimeRelevant(file),
    ),
  );
  const hermesCliAdapterFiles = stableUnique(
    changedFiles.filter(
      (file) => HERMES_CLI_ADAPTER_RUNTIME_FILES.has(file) && isRuntimeRelevant(file),
    ),
  );
  const hermesCronRestoreFiles = stableUnique(
    changedFiles.filter(
      (file) => HERMES_CRON_RESTORE_RUNTIME_FILES.has(file) && isRuntimeRelevant(file),
    ),
  );
  const hermesManagedPolicyFiles = stableUnique(
    changedFiles.filter(
      (file) =>
        (file.startsWith("agents/hermes/config/") || HERMES_MANAGED_POLICY_FILES.has(file)) &&
        isRuntimeRelevant(file),
    ),
  );
  const messagingRuntimeFiles = stableUnique(
    changedFiles.filter(
      (file) =>
        (MESSAGING_RUNTIME_FILES.has(file) ||
          MESSAGING_RUNTIME_PREFIXES.some((prefix) => file.startsWith(prefix))) &&
        isRuntimeRelevant(file),
    ),
  );
  const hermesMessagingRuntimeFiles = stableUnique(
    changedFiles.filter(
      (file) => HERMES_STARTUP_RUNTIME_FILES.has(file) && isRuntimeRelevant(file),
    ),
  );
  const openClawMessagingRuntimeFiles = stableUnique(
    changedFiles.filter(
      (file) => OPENCLAW_STARTUP_RUNTIME_FILES.has(file) && isRuntimeRelevant(file),
    ),
  );
  return [
    ...(journaledRecreateResumeFiles.length > 0
      ? [
          {
            id: "openshell-gateway-upgrade",
            matchedFiles: journaledRecreateResumeFiles,
          },
        ]
      : []),
    ...MANAGED_STARTUP_E2E_JOB_IDS.map((id) => ({
      id,
      matchedFiles: managedStartupFiles,
    })),
    ...HERMES_CLI_ADAPTER_E2E_JOB_IDS.map((id) => ({
      id,
      matchedFiles: hermesCliAdapterFiles,
    })),
    ...HERMES_CRON_RESTORE_E2E_JOB_IDS.map((id) => ({
      id,
      matchedFiles: hermesCronRestoreFiles,
    })),
    ...HERMES_MANAGED_POLICY_E2E_JOB_IDS.map((id) => ({
      id,
      matchedFiles: hermesManagedPolicyFiles,
    })),
    ...SHARED_MESSAGING_RUNTIME_E2E_JOB_IDS.map((id) => ({
      id,
      matchedFiles: messagingRuntimeFiles,
    })),
    ...HERMES_MESSAGING_RUNTIME_E2E_JOB_IDS.map((id) => ({
      id,
      matchedFiles: hermesMessagingRuntimeFiles,
    })),
    ...OPENCLAW_MESSAGING_RUNTIME_E2E_JOB_IDS.map((id) => ({
      id,
      matchedFiles: openClawMessagingRuntimeFiles,
    })),
  ].filter((selection) => selection.matchedFiles.length > 0);
}

export const RISK_RULES: readonly RiskRule[] = [
  {
    id: "lifecycle-state",
    summary:
      "Onboarding and sandbox state must converge across persisted metadata, reported status, and the live runtime.",
    tier: 2,
    requiredJobs: ["onboard-resume", "onboard-repair"],
    invariants: [
      "partial failure and retry converge without ghost resources or stale ports",
      "status agrees with independently probed gateway and sandbox state",
      "cleanup preserves unrelated sandboxes and removes only owned resources",
    ],
    matches: (file) =>
      file === "src/lib/onboard.ts" ||
      file.startsWith("src/lib/onboard/") ||
      file.startsWith("src/lib/state/") ||
      STATEFUL_SANDBOX_FILE.test(file),
  },
  {
    id: "gateway-topology",
    summary:
      "Gateway topology changes must keep sandbox-visible host addresses outside sandbox network subnets and use one address authority.",
    tier: 2,
    requiredJobs: [],
    invariants: [
      "An explicit sandbox-visible host address must be outside the sandbox network subnet, and every gateway-address projection must derive from the same authority.",
    ],
    matches: (file) => GATEWAY_TOPOLOGY_FILE_SET.has(file),
  },
  {
    id: "upgrade-rebuild",
    summary:
      "Upgrade, rebuild, snapshot, and restore operations must preserve user state while replacing stale runtime state.",
    tier: 2,
    requiredJobs: ["rebuild-openclaw", "state-backup-restore"],
    invariants: [
      "host and in-sandbox runtime versions agree after mutation",
      "credentials, policy, messaging, and workspace state survive intended preservation paths",
      "failed mutations remain retryable without destructive cleanup",
    ],
    matches: (file) =>
      (file.startsWith("src/") ||
        file.startsWith("nemoclaw/") ||
        file.startsWith("scripts/") ||
        file.startsWith("nemoclaw-blueprint/")) &&
      MUTATION_FILE.test(file),
  },
  {
    id: "shared-agent",
    summary:
      "Shared agent abstractions must retain equivalent lifecycle behavior for OpenClaw and Hermes.",
    tier: 2,
    requiredJobs: ["full-e2e", "hermes-e2e"],
    invariants: [
      "shared behavior does not assume an OpenClaw-only path, token, port, or filesystem layout",
      "both supported agents become ready and complete a real turn",
    ],
    matches: (file) =>
      file.startsWith("src/lib/agent/") ||
      file.startsWith("src/lib/actions/sandbox/agents/") ||
      /^src\/lib\/actions\/sandbox\/mcp-bridge-(?:adapter|provider)/.test(file) ||
      file === "src/lib/messaging/applier/agent-config.ts",
  },
  {
    id: "inference-policy",
    summary:
      "Inference selection, reachability, and network policy must agree at the real host-to-sandbox boundary.",
    tier: 2,
    requiredJobs: ["inference-routing", "network-policy"],
    invariants: [
      "the selected provider is reachable through the route advertised to the agent",
      "health reflects a real request rather than configuration presence",
      "network policy permits the intended route and denies unintended egress",
    ],
    matches: (file) =>
      file.startsWith("src/lib/inference/") ||
      file.startsWith("src/lib/actions/inference") ||
      file.startsWith("src/lib/policy/") ||
      file.startsWith("nemoclaw-blueprint/policies/") ||
      PRIVATE_NETWORK_BOUNDARY_FILES.has(file) ||
      /^src\/lib\/actions\/sandbox\/.*policy/.test(file) ||
      INFERENCE_POLICY_FILE.test(file),
  },
  {
    id: "messaging-lifecycle",
    summary:
      "Messaging changes must preserve the manifest-to-policy-to-runtime lifecycle through restart and removal.",
    tier: 2,
    requiredJobs: ["channels-add-remove", "channels-stop-start"],
    invariants: [
      "channel credentials and policy are applied to the intended agent only",
      "restart or rebuild restores the configured channel",
      "removal tears down runtime, policy, session, and persisted state",
    ],
    matches: (file) =>
      file.startsWith("src/lib/messaging/") ||
      file === "src/lib/messaging-channel-config.ts" ||
      /src\/lib\/actions\/sandbox\/.*(?:channel|messaging)/.test(file),
  },
  {
    id: "platform-install",
    summary:
      "Installer and platform changes must work on a clean supported host with the pinned runtime dependencies.",
    tier: 3,
    requiredJobs: ["cloud-onboard"],
    invariants: [
      "a clean host installs the intended pinned dependencies and reaches a usable agent",
      "platform detection does not silently downgrade required runtime validation",
    ],
    matches: (file) =>
      file === "src/lib/platform.ts" ||
      file.startsWith("src/lib/onboard/machine/") ||
      INSTALL_SCRIPT.test(file) ||
      /(?:^|\/)Dockerfile(?:\.|$)/.test(file) ||
      file === "ci/platform-matrix.json" ||
      file === ".github/workflows/e2e.yaml" ||
      file.startsWith(".github/actions/prepare-e2e/") ||
      file === "src/lib/trace.ts" ||
      file === "scripts/scorecard/analyze-trace-timing.mts" ||
      file === "scripts/e2e/sanitize-trace-timing.py" ||
      file === "ci/onboard-performance-budget.json" ||
      RISK_RELEVANT_TEST_FILES.has(file),
  },
  {
    id: "openclaw-image",
    summary: "OpenClaw final-image changes must preserve cold onboarding and a usable first turn.",
    tier: 3,
    requiredJobs: ["full-e2e"],
    invariants: [
      "the repository-root image builds through the same cold path exercised by supported hosts",
      "the resulting OpenClaw sandbox becomes ready and completes a real first turn",
    ],
    matches: (file) => file === "Dockerfile",
  },
  {
    id: "credentials-security",
    summary:
      "Credential and security-boundary changes must preserve secrecy, sanitization, and fail-closed policy behavior.",
    tier: 3,
    requiredJobs: ["cloud-inference", "security-posture"],
    invariants: [
      "plaintext credentials do not cross logs, snapshots, artifacts, or sandbox boundaries",
      "invalid or missing security state fails closed",
      "recovery and migration preserve references without reviving removed secrets",
    ],
    matches: (file) =>
      file.startsWith("src/lib/credentials/") ||
      POLICY_SECURITY_FILE.test(file) ||
      PRIVATE_NETWORK_BOUNDARY_FILES.has(file) ||
      CREDENTIAL_SECURITY_FILE.test(file) ||
      file.startsWith("nemoclaw/src/blueprint/ssrf"),
  },
  {
    id: "e2e-control-plane",
    summary:
      "E2E selection, execution, and evidence changes must preserve trusted dispatch and fail-closed result classification.",
    tier: 3,
    requiredJobs: ["cloud-onboard", "cloud-inference", "security-posture"],
    invariants: [
      "the controller selects only trusted jobs and binds results to the intended PR commit",
      "single-shard and matrix jobs both emit complete evidence through the canonical reporter",
      "missing, skipped, malformed, or mismatched evidence cannot produce a passing gate",
    ],
    matches: (file) =>
      E2E_CONTROL_PLANE_FILES.has(file) ||
      file.startsWith("tools/e2e/") ||
      file.startsWith("test/e2e/") ||
      file.startsWith(".github/actions/prepare-e2e/") ||
      file.startsWith(".github/actions/upload-e2e-artifacts/"),
  },
  {
    id: "managed-image-multiarch",
    summary:
      "Protected managed-image qualification must build and directly start every shipped agent on each supported architecture from exact base and candidate digests.",
    tier: 3,
    requiredJobs: [PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID],
    invariants: [
      "OpenClaw, Hermes, and Deep Agents Code use platform-specific digest-pinned bases from one exact PR head and cohort",
      "each built image is addressed by its isolated-registry digest and exercises the managed root-stdin and sandbox-hold startup boundary",
      "amd64 and arm64 shards emit exact head, base, platform, cohort, image, and direct-start evidence before cleanup",
      "the isolated registry is removed before a shard can publish passing risk evidence",
    ],
    // Keep this source boundary synchronized with the managed-image workflow's
    // path filter. The preceding trusted-controller slice intentionally matched
    // only the activation marker; after that lane lands, this candidate can
    // select and prove its own exact head before broadening future qualification.
    matches: (file) =>
      MANAGED_IMAGE_MULTIARCH_INPUTS.has(file) ||
      MANAGED_IMAGE_MULTIARCH_CHILD_CREDENTIALS.test(file) ||
      MANAGED_IMAGE_MULTIARCH_INPUT_PREFIXES.some((prefix) => file.startsWith(prefix)),
  },
  {
    id: MANAGED_IMAGE_PROTECTED_RUNTIME_JOB_ID,
    summary:
      "Protected managed-image runtime qualification must retain real GPU access, host-local Ollama, NVIDIA NIM, vLLM, transactional rollback, and exact cleanup for every shipped agent.",
    tier: 3,
    requiredJobs: [
      MANAGED_IMAGE_PROTECTED_RUNTIME_JOB_ID,
      PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID,
    ],
    invariants: [
      "OpenClaw, Hermes, and Deep Agents Code run from exact PR image digests through the production managed-bootstrap path",
      "the exact all-agent image cohort passes native linux/amd64 and linux/arm64 startup qualification",
      "real NVIDIA GPU access and host-local Ollama, NVIDIA NIM, and vLLM inference.local completions are all required",
      "bootstrap completion failure removes the exact failed sandbox, container, network, and transaction state for every agent",
      "NGC credentials remain host-scoped and never enter a managed sandbox or persisted artifact",
    ],
    // Keep this source boundary synchronized with the protected managed-image
    // runtime workflow path filter. The trusted workflow and validator are
    // already on main. Activation now
    // binds every production bootstrap/rebuild input to both exact all-agent
    // multiarch startup and the native-GPU local-inference runtime proof.
    matches: (file) =>
      MANAGED_IMAGE_PROTECTED_RUNTIME_INPUTS.has(file) ||
      MANAGED_IMAGE_PROTECTED_RUNTIME_INPUT_PREFIXES.some((prefix) => file.startsWith(prefix)),
  },
  {
    id: LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    summary:
      "Protected DGX Spark qualification must build and prove the exact NemoClaw-built llama.cpp ARM64 image candidate from declarative serving YAML.",
    tier: 3,
    requiredJobs: [LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID],
    invariants: [
      "trusted main workflow code compiles candidate YAML and builds the exact PR head without executing candidate workflow code",
      "one physical NVIDIA DGX Spark proves the exact model digest, image digest, server health, authenticated completion, and full GPU offload",
      "the isolated registry, server container, network, credential file, and listener are removed before passing evidence is uploaded",
    ],
    // The trusted workflow and validators land while dormant. A later YAML-only
    // activation candidate selects this protected lane after the Spark runner,
    // approval environment, and verified local model path are provisioned.
    matches: (file) =>
      file === LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH ||
      file === LLAMA_CPP_DGX_SPARK_AGENT_QUALIFICATION_PATH,
  },
  {
    id: "sandbox-boundary",
    summary:
      "Sandbox blueprint and agent-runtime changes must preserve equivalent isolation and readiness across supported agents.",
    tier: 3,
    requiredJobs: ["full-e2e", "hermes-e2e", "hermes-inference-switch", "security-posture"],
    invariants: [
      "OpenClaw and Hermes both reach readiness through the changed sandbox boundary",
      "the Hermes runtime and managed inference route agree on the selected provider and model after each route change",
      "the sandbox retains its required security posture and isolation controls",
      "blueprint state agrees with the runtime observed by both supported agents",
    ],
    matches: (file) =>
      file.startsWith("nemoclaw/src/blueprint/") ||
      file === "nemoclaw-blueprint/blueprint.yaml" ||
      file.startsWith("agents/hermes/"),
  },
] as const;

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeFocusedE2eJobs(
  selections: readonly TrustedFocusedE2eJob[],
  changedFiles: readonly string[],
): Array<{ id: string; matchedFiles: string[] }> {
  const changedFileSet = new Set(changedFiles);
  const matchedFilesByJob = new Map<string, string[]>();
  for (const selection of selections) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(selection.id)) {
      throw new Error(`focused E2E job id is invalid: ${selection.id}`);
    }
    const matchedFiles = stableUnique(selection.matchedFiles);
    if (matchedFiles.length === 0) {
      throw new Error(`focused E2E job has no matched files: ${selection.id}`);
    }
    for (const file of matchedFiles) {
      if (!changedFileSet.has(file)) {
        throw new Error(`focused E2E file is not present in changedFiles: ${file}`);
      }
    }
    matchedFilesByJob.set(
      selection.id,
      stableUnique([...(matchedFilesByJob.get(selection.id) ?? []), ...matchedFiles]),
    );
  }
  return [...matchedFilesByJob]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, matchedFiles]) => ({ id, matchedFiles }));
}

function isRuntimeRelevant(file: string): boolean {
  if (RISK_RELEVANT_TEST_FILES.has(file)) return true;
  if (E2E_SUPPORT_FILE.test(file)) return false;
  if (file.startsWith("tools/e2e/") || file.startsWith("test/e2e/")) {
    return !/\.(?:md|mdx)$/u.test(file);
  }
  return !(
    file.startsWith("docs/") ||
    file.startsWith("fern/") ||
    /(?:^|\/)(?:test|tests|__tests__)\//.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]s$/.test(file) ||
    /\.(?:md|mdx|txt)$/.test(file)
  );
}

function planDigest(value: Omit<RiskPlan, "planHash">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildRiskPlan(options: {
  headSha: string;
  changedFiles: readonly string[];
  focusedE2eJobs?: readonly TrustedFocusedE2eJob[];
}): RiskPlan {
  const changedFiles = stableUnique(options.changedFiles);
  const runtimeFiles = changedFiles.filter(isRuntimeRelevant);
  const focusedE2eJobs = normalizeFocusedE2eJobs(
    [...focusedPrE2eJobsForChangedFiles(changedFiles), ...(options.focusedE2eJobs ?? [])],
    changedFiles,
  );
  const focusedLiveFiles = new Set(focusedE2eJobs.flatMap((selection) => selection.matchedFiles));
  const staticFamilies: RiskPlanFamily[] = RISK_RULES.flatMap((rule) => {
    const matchedFiles = runtimeFiles.filter(
      (file) =>
        rule.matches(file) && !(rule.id === "e2e-control-plane" && focusedLiveFiles.has(file)),
    );
    if (matchedFiles.length === 0) return [];
    return [
      {
        id: rule.id,
        summary: rule.summary,
        tier: rule.tier,
        matchedFiles,
        invariants: [...rule.invariants],
        requiredJobs: [...rule.requiredJobs],
        requiredTargets: [],
      },
    ];
  });
  const focusedE2eTargets = normalizeFocusedE2eJobs(
    focusedPrE2eTargetsForChangedFiles(changedFiles),
    changedFiles,
  );
  const focusedFamilies: RiskPlanFamily[] =
    focusedE2eJobs.length === 0 && focusedE2eTargets.length === 0
      ? []
      : [
          {
            id: "focused-e2e",
            summary: FOCUSED_E2E_SUMMARY,
            tier: 2,
            matchedFiles: stableUnique(
              [...focusedE2eJobs, ...focusedE2eTargets].flatMap(
                (selection) => selection.matchedFiles,
              ),
            ),
            invariants: [...FOCUSED_E2E_INVARIANTS],
            requiredJobs: focusedE2eJobs.map((job) => job.id),
            requiredTargets: focusedE2eTargets.map((target) => target.id),
          },
        ];
  const families = [...staticFamilies, ...focusedFamilies];

  const jobs = new Map<string, RiskPlanJob>();
  for (const family of staticFamilies) {
    for (const id of family.requiredJobs) {
      const existing = jobs.get(id) ?? {
        id,
        tier: family.tier,
        families: [],
        reasons: [],
        matchedFiles: [],
      };
      existing.tier = Math.max(existing.tier, family.tier) as Exclude<RiskTier, 0>;
      existing.families = stableUnique([...existing.families, family.id]) as RiskFamilyId[];
      existing.reasons = stableUnique([...existing.reasons, family.summary]);
      existing.matchedFiles = stableUnique([...existing.matchedFiles, ...family.matchedFiles]);
      jobs.set(id, existing);
    }
  }
  for (const selection of focusedE2eJobs) {
    const existing = jobs.get(selection.id) ?? {
      id: selection.id,
      tier: 2,
      families: [],
      reasons: [],
      matchedFiles: [],
    };
    existing.tier = Math.max(existing.tier, 2) as Exclude<RiskTier, 0>;
    existing.families = stableUnique([...existing.families, "focused-e2e"]) as RiskFamilyId[];
    existing.reasons = stableUnique([...existing.reasons, FOCUSED_E2E_SUMMARY]);
    existing.matchedFiles = stableUnique([...existing.matchedFiles, ...selection.matchedFiles]);
    jobs.set(selection.id, existing);
  }

  const targets = new Map<string, RiskPlanTarget>();
  for (const selection of focusedE2eTargets) {
    targets.set(selection.id, {
      id: selection.id,
      tier: 2,
      families: ["focused-e2e"],
      reasons: [FOCUSED_E2E_SUMMARY],
      matchedFiles: [...selection.matchedFiles],
    });
  }

  const requiredJobs = [...jobs.values()].sort(
    (left, right) => right.tier - left.tier || left.id.localeCompare(right.id),
  );
  const requiredTargets = [...targets.values()].sort(
    (left, right) => right.tier - left.tier || left.id.localeCompare(right.id),
  );
  const tier = families.reduce<RiskTier>(
    (highest, family) => Math.max(highest, family.tier) as RiskTier,
    0,
  );
  const withoutHash: Omit<RiskPlan, "planHash"> = {
    version: RISK_PLAN_VERSION,
    headSha: options.headSha,
    changedFiles,
    tier,
    families,
    requiredJobs,
    requiredTargets,
  };

  return { ...withoutHash, planHash: planDigest(withoutHash) };
}

export function riskPlanRequiredJobIds(plan: RiskPlan): string[] {
  return plan.requiredJobs.map((job) => job.id);
}

export function riskPlanRequiredTargetIds(plan: RiskPlan): string[] {
  return plan.requiredTargets.map((target) => target.id);
}
