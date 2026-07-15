// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const RISK_PLAN_VERSION = 3 as const;

export type RiskTier = 0 | 1 | 2 | 3;
export type RiskFamilyId =
  | "lifecycle-state"
  | "upgrade-rebuild"
  | "shared-agent"
  | "inference-policy"
  | "messaging-lifecycle"
  | "platform-install"
  | "credentials-security"
  | "e2e-control-plane"
  | "sandbox-boundary"
  | "focused-e2e";

export type TrustedFocusedE2eJob = {
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
};

export type RiskPlanJob = {
  id: string;
  tier: Exclude<RiskTier, 0>;
  families: RiskFamilyId[];
  reasons: string[];
  matchedFiles: string[];
};

export type RiskPlan = {
  version: typeof RISK_PLAN_VERSION;
  headSha: string;
  planHash: string;
  changedFiles: string[];
  tier: RiskTier;
  families: RiskPlanFamily[];
  requiredJobs: RiskPlanJob[];
};

type RiskRule = Omit<RiskPlanFamily, "matchedFiles"> & {
  matches(file: string): boolean;
};

const STATEFUL_SANDBOX_FILE = /^src\/lib\/actions\/sandbox\/.*\.ts$/;
const MUTATION_FILE = /(?:upgrade|rebuild|snapshot|backup|restore)/;
const INSTALL_SCRIPT = /^(?:install\.sh|scripts\/(?:install|setup|dev-setup)[^/]*\.(?:sh|js|ts))$/;
const INFERENCE_POLICY_FILE = /(?:^|[/.-])(?:inference|network-policy)(?:[/.-]|$)/;
const CREDENTIAL_SECURITY_FILE =
  /(?:^|[/.-])(?:credential|credentials|secret|secrets|redact|redaction|ssrf|shields|security)(?:[/.-]|$)/i;
const E2E_CONTROL_PLANE_FILES = new Set([
  ".github/workflows/e2e.yaml",
  ".github/workflows/pr-e2e-gate.yaml",
  ".github/workflows/pr.yaml",
  "package-lock.json",
  "package.json",
  "tools/advisors/github.mts",
  "tools/advisors/io.mts",
  "tools/advisors/risk-plan.mts",
  "vitest.config.ts",
]);
const TRUSTED_CONTROL_PLANE_ONLY_FILES = new Set([
  ".github/workflows/pr-e2e-gate.yaml",
  "tools/e2e/pr-e2e-gate.mts",
  "tools/e2e/pr-e2e-required.mts",
]);
// These checked-in paths and directories are the source boundary for private-network,
// policy, and shields enforcement but are not all covered by the token heuristics above.
// Keep the explicit floor until a machine-readable security-owner catalog replaces it.
const PRIVATE_NETWORK_BOUNDARY_FILES = new Set([
  "nemoclaw-blueprint/private-networks.yaml",
  "nemoclaw/src/blueprint/private-networks.ts",
]);
const POLICY_SECURITY_FILE = /^src\/lib\/(?:policy|shields)\//;
// Ordinary tests do not raise the runtime floor. These files either define a live
// platform contract or produce the evidence consumed by the trusted PR gate.
const RISK_RELEVANT_TEST_FILES = new Set([
  "test/e2e/live/cloud-onboard.test.ts",
  "test/e2e/risk-signal-reporter.ts",
]);
const FOCUSED_E2E_SUMMARY =
  "Changed workflow-wired E2E tests must execute through their trusted canonical jobs.";
const FOCUSED_E2E_INVARIANTS = [
  "the changed test remains wired to a selector declared by the trusted workflow",
  "the canonical job executes the changed test rather than treating it as advisory coverage",
] as const;

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
    id: "upgrade-rebuild",
    summary:
      "Upgrade, rebuild, snapshot, and restore operations must preserve user state while replacing stale runtime state.",
    tier: 2,
    requiredJobs: ["upgrade-stale-sandbox", "state-backup-restore"],
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
      file === "scripts/scorecard/analyze-trace-timing.ts" ||
      file === "scripts/e2e/sanitize-trace-timing.py" ||
      file === "ci/onboard-performance-budget.json" ||
      RISK_RELEVANT_TEST_FILES.has(file),
  },
  {
    id: "credentials-security",
    summary:
      "Credential and security-boundary changes must preserve secrecy, sanitization, and fail-closed policy behavior.",
    tier: 3,
    requiredJobs: ["credential-sanitization", "security-posture"],
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
    requiredJobs: ["cloud-onboard", "credential-sanitization", "security-posture"],
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
    id: "sandbox-boundary",
    summary:
      "Sandbox blueprint and agent-runtime changes must preserve equivalent isolation and readiness across supported agents.",
    tier: 3,
    requiredJobs: ["full-e2e", "hermes-e2e", "security-posture"],
    invariants: [
      "OpenClaw and Hermes both reach readiness through the changed sandbox boundary",
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
  const staticFamilies: RiskPlanFamily[] = RISK_RULES.flatMap((rule) => {
    const matchedFiles = runtimeFiles.filter(rule.matches);
    if (matchedFiles.length === 0) return [];
    return [
      {
        id: rule.id,
        summary: rule.summary,
        tier: rule.tier,
        matchedFiles,
        invariants: [...rule.invariants],
        requiredJobs: [...rule.requiredJobs],
      },
    ];
  });
  const focusedE2eJobs = normalizeFocusedE2eJobs(options.focusedE2eJobs ?? [], changedFiles);
  const focusedFamilies: RiskPlanFamily[] =
    focusedE2eJobs.length === 0
      ? []
      : [
          {
            id: "focused-e2e",
            summary: FOCUSED_E2E_SUMMARY,
            tier: 2,
            matchedFiles: stableUnique(focusedE2eJobs.flatMap((job) => job.matchedFiles)),
            invariants: [...FOCUSED_E2E_INVARIANTS],
            requiredJobs: focusedE2eJobs.map((job) => job.id),
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

  const requiredJobs = [...jobs.values()].sort(
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
  };

  return { ...withoutHash, planHash: planDigest(withoutHash) };
}

export function riskPlanRequiredJobIds(plan: RiskPlan): string[] {
  return plan.requiredJobs.map((job) => job.id);
}

export function requiresCredentialedE2eAuthorization(plan: RiskPlan): boolean {
  const controlPlane = plan.families.find((family) => family.id === "e2e-control-plane");
  return (
    controlPlane?.matchedFiles.some((file) => !TRUSTED_CONTROL_PLANE_ONLY_FILES.has(file)) ?? false
  );
}
