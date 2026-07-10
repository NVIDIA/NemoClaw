// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildRiskPlan, RISK_RULES, riskPlanRequiredJobIds } from "../tools/advisors/risk-plan.mts";
import { readFreeStandingJobsInventory } from "../tools/e2e/workflow-boundary.mts";
import { classifyTestDepth } from "../tools/pr-review-advisor/analyze.mts";

const HEAD_SHA = "a".repeat(40);

function plan(...changedFiles: string[]) {
  return buildRiskPlan({ headSha: HEAD_SHA, changedFiles });
}

describe("deterministic PR risk plan", () => {
  it("emits a stable plan and digest for equivalent inputs", () => {
    const first = plan("src/lib/state/registry.ts", "src/lib/onboard.ts");
    const second = plan("src/lib/onboard.ts", "src/lib/state/registry.ts");

    expect(first).toEqual(second);
    expect(first.headSha).toBe(HEAD_SHA);
    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.changedFiles).toEqual(["src/lib/onboard.ts", "src/lib/state/registry.ts"]);
  });

  it("does not require runtime E2E for docs and ordinary tests", () => {
    const result = plan("docs/get-started/quickstart.mdx", "test/onboard.test.ts");

    expect(result.tier).toBe(0);
    expect(result.families).toEqual([]);
    expect(result.requiredJobs).toEqual([]);
    expect(result.requiresManualExpansion).toBe(false);
  });

  it("keeps the canonical cloud-onboard live test in the platform floor (#6446)", () => {
    const canonical = plan("test/e2e/live/cloud-onboard.test.ts");
    const ordinaryLiveTest = plan("test/e2e/live/full.test.ts");

    expect(canonical.families.map((family) => family.id)).toContain("platform-install");
    expect(riskPlanRequiredJobIds(canonical)).toContain("cloud-onboard");
    expect(ordinaryLiveTest.families).toEqual([]);
    expect(ordinaryLiveTest.requiredJobs).toEqual([]);
  });

  it("does not infer security or inference risk from unrelated path substrings", () => {
    const result = plan("src/lib/actions/sandbox/mcp-bridge-provider.ts", "src/lib/secretary.ts");

    expect(result.families.map((family) => family.id)).toEqual(
      expect.arrayContaining(["lifecycle-state", "shared-agent"]),
    );
    expect(result.families.map((family) => family.id)).not.toContain("credentials-security");
    expect(result.families.map((family) => family.id)).not.toContain("inference-policy");
    expect(riskPlanRequiredJobIds(result)).toEqual(
      expect.arrayContaining(["full-e2e", "hermes-e2e", "onboard-repair", "onboard-resume"]),
    );
  });

  it.each([
    "src/lib/actions/sandbox/connect-flow.ts",
    "src/lib/actions/sandbox/destroy-flow.ts",
    "src/lib/actions/sandbox/sessions/export.ts",
    "src/lib/actions/sandbox/terminal-connect-probe.ts",
  ])("keeps every sandbox action under the lifecycle-state floor: %s", (file) => {
    const result = plan(file);

    expect(result.families.map((family) => family.id)).toContain("lifecycle-state");
    expect(riskPlanRequiredJobIds(result)).toEqual(
      expect.arrayContaining(["onboard-repair", "onboard-resume"]),
    );
  });

  it.each([
    {
      file: "src/lib/onboard.ts",
      family: "lifecycle-state",
      jobs: ["onboard-resume", "onboard-repair"],
    },
    {
      file: "src/lib/actions/upgrade-sandboxes.ts",
      family: "upgrade-rebuild",
      jobs: ["state-backup-restore", "upgrade-stale-sandbox"],
    },
    {
      file: "src/lib/actions/sandbox/agents/apply.ts",
      family: "shared-agent",
      jobs: ["full-e2e", "hermes-e2e"],
    },
    {
      file: "src/lib/inference/health.ts",
      family: "inference-policy",
      jobs: ["inference-routing", "network-policy"],
    },
    {
      file: "nemoclaw-blueprint/policies/presets/brew.yaml",
      family: "inference-policy",
      jobs: ["inference-routing", "network-policy"],
    },
    {
      file: "src/lib/messaging/applier/agent-config.ts",
      family: "messaging-lifecycle",
      jobs: ["channels-add-remove", "channels-stop-start"],
    },
    {
      file: "install.sh",
      family: "platform-install",
      jobs: ["cloud-onboard"],
    },
    {
      file: "src/lib/credentials/provider-list.ts",
      family: "credentials-security",
      jobs: ["credential-sanitization", "security-posture"],
    },
  ])("maps $family changes to a reviewed E2E floor", ({ file, family, jobs }) => {
    const result = plan(file);

    expect(result.families.map((item) => item.id)).toContain(family);
    expect(riskPlanRequiredJobIds(result)).toEqual(expect.arrayContaining(jobs));
  });

  it.each([
    {
      file: "nemoclaw-blueprint/private-networks.yaml",
      families: ["inference-policy", "credentials-security"],
      jobs: ["inference-routing", "network-policy", "credential-sanitization", "security-posture"],
    },
    {
      file: "nemoclaw/src/blueprint/private-networks.ts",
      families: ["inference-policy", "credentials-security"],
      jobs: ["inference-routing", "network-policy", "credential-sanitization", "security-posture"],
    },
    {
      file: "src/lib/policy/managed-policy-binding.ts",
      families: ["inference-policy", "credentials-security"],
      jobs: ["inference-routing", "network-policy", "credential-sanitization", "security-posture"],
    },
    {
      file: "src/lib/shields/verify-lock.ts",
      families: ["credentials-security"],
      jobs: ["credential-sanitization", "security-posture"],
    },
  ])("keeps the $file security boundary in the deterministic floor", ({ file, families, jobs }) => {
    const result = plan(file);

    expect(result.families.map((family) => family.id)).toEqual(expect.arrayContaining(families));
    expect(riskPlanRequiredJobIds(result)).toEqual(expect.arrayContaining(jobs));
  });

  it("caps automatic execution without dropping required evidence", () => {
    const result = plan(
      "src/lib/onboard.ts",
      "src/lib/messaging/applier/agent-config.ts",
      "src/lib/inference/health.ts",
    );

    expect(result.requiredJobs.length).toBeGreaterThan(result.maxAutomaticJobs);
    expect(result.automaticJobs).toHaveLength(result.maxAutomaticJobs);
    expect(result.requiresManualExpansion).toBe(true);
    expect(result.requiredJobs.map((job) => job.id)).toEqual(
      expect.arrayContaining(result.automaticJobs),
    );
  });

  it("raises PR review test depth for a matched runtime risk", () => {
    const result = classifyTestDepth(["src/lib/state/registry.ts"]);

    expect(result.verdict).toBe("runtime_validation_recommended");
    expect(result.suggestedTests.join("\n")).toContain("onboard-resume");
    expect(result.suggestedTests.join("\n")).toContain("`src/lib/state/registry.ts`");
  });

  it("keeps every catalog job wired into the canonical E2E workflow", () => {
    const allowedJobs = new Set(readFreeStandingJobsInventory().allowedJobs);
    const configuredJobs = new Set(RISK_RULES.flatMap((rule) => rule.requiredJobs));

    expect([...configuredJobs].filter((job) => !allowedJobs.has(job))).toEqual([]);
  });
});
