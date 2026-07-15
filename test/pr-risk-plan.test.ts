// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildRiskPlan,
  RISK_RULES,
  requiresCredentialedE2eAuthorization,
  riskPlanRequiredJobIds,
} from "../tools/advisors/risk-plan.mts";
import {
  focusedE2eJobsForChangedFiles,
  readFreeStandingJobsInventory,
} from "../tools/e2e/workflow-boundary.mts";
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
    expect(first.version).toBe(3);
    expect(first.headSha).toBe(HEAD_SHA);
    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.changedFiles).toEqual(["src/lib/onboard.ts", "src/lib/state/registry.ts"]);
  });

  it("does not require runtime E2E for docs and ordinary tests", () => {
    const result = plan("docs/get-started/quickstart.mdx", "test/onboard.test.ts");

    expect(result.tier).toBe(0);
    expect(result.families).toEqual([]);
    expect(result.requiredJobs).toEqual([]);
  });

  it("keeps every live test behind the control-plane exception and preserves the cloud floor (#6446)", () => {
    const canonical = plan("test/e2e/live/cloud-onboard.test.ts");
    const ordinaryLiveTest = plan("test/e2e/live/full.test.ts");

    expect(canonical.families.map((family) => family.id)).toContain("platform-install");
    expect(canonical.families.map((family) => family.id)).toContain("e2e-control-plane");
    expect(riskPlanRequiredJobIds(canonical)).toContain("cloud-onboard");
    expect(ordinaryLiveTest.families.map((family) => family.id)).toEqual(["e2e-control-plane"]);
    expect(riskPlanRequiredJobIds(ordinaryLiveTest)).toEqual([
      "cloud-onboard",
      "credential-sanitization",
      "security-posture",
    ]);
  });

  it("hashes trusted focused E2E selections into their canonical jobs", () => {
    const changedFiles = ["test/e2e/live/token-rotation.test.ts"];
    const focusedE2eJobs = focusedE2eJobsForChangedFiles(changedFiles);
    const result = buildRiskPlan({ headSha: HEAD_SHA, changedFiles, focusedE2eJobs });
    const withoutFocusedSelection = buildRiskPlan({ headSha: HEAD_SHA, changedFiles });

    expect(focusedE2eJobs).toEqual([
      {
        id: "token-rotation",
        matchedFiles: ["test/e2e/live/token-rotation.test.ts"],
      },
    ]);
    expect(result.families).toContainEqual(
      expect.objectContaining({
        id: "focused-e2e",
        matchedFiles: ["test/e2e/live/token-rotation.test.ts"],
        requiredJobs: ["token-rotation"],
      }),
    );
    expect(result.requiredJobs).toContainEqual(
      expect.objectContaining({
        id: "token-rotation",
        families: ["focused-e2e"],
        matchedFiles: ["test/e2e/live/token-rotation.test.ts"],
      }),
    );
    expect(result.planHash).not.toBe(withoutFocusedSelection.planHash);
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

  it.each([
    ".github/workflows/e2e.yaml",
    ".github/workflows/pr-e2e-gate.yaml",
    ".github/workflows/pr.yaml",
    ".github/actions/prepare-e2e/action.yaml",
    ".github/actions/upload-e2e-artifacts/action.yaml",
    "package-lock.json",
    "package.json",
    "vitest.config.ts",
    "tools/advisors/github.mts",
    "tools/advisors/io.mts",
    "tools/advisors/risk-plan.mts",
    "tools/e2e/pr-e2e-gate.mts",
    "tools/e2e/pr-e2e-required.mts",
    "tools/e2e/risk-signal.ts",
    "tools/e2e/private-file.ts",
    "tools/e2e/workflow-plan.mts",
    "tools/e2e/workflow-boundary.mts",
    "tools/e2e/job-map.txt",
    "test/e2e/registry/runtime-support.ts",
    "test/e2e/risk-signal-reporter.ts",
    "test/e2e/lib/security-posture-assertions.sh",
    "test/e2e/lib/redact-text.py",
    "test/e2e/lib/fake-slack-api.cjs",
    "test/e2e/fixtures/runtime-input.txt",
    "test/e2e/e2e-cloud-experimental/full-e2e",
    "test/e2e/live/registry-targets.test.ts",
    "test/e2e/live/runtime-overrides.test.ts",
    "test/e2e/live/dashboard-remote-bind.test.ts",
  ])("keeps the E2E control plane in a fail-closed runtime floor: %s", (file) => {
    const result = plan(file);

    expect(result.families.map((family) => family.id)).toContain("e2e-control-plane");
    expect(riskPlanRequiredJobIds(result)).toEqual(
      expect.arrayContaining(["cloud-onboard", "credential-sanitization", "security-posture"]),
    );
  });

  it("keeps E2E documentation outside the credentialed control-plane exception", () => {
    const result = plan("test/e2e/README.md", "test/e2e/docs/README.md");

    expect(result.families).toEqual([]);
    expect(result.requiredJobs).toEqual([]);
  });

  it("runs controller-only changes without credentialed E2E authorization", () => {
    const result = plan(
      ".github/workflows/pr-e2e-gate.yaml",
      "tools/e2e/pr-e2e-gate.mts",
      "tools/e2e/pr-e2e-required.mts",
    );

    expect(result.families.map((family) => family.id)).toContain("e2e-control-plane");
    expect(requiresCredentialedE2eAuthorization(result)).toBe(false);
  });

  it.each([
    ".github/workflows/e2e.yaml",
    "test/e2e/risk-signal-reporter.ts",
    "tools/e2e/workflow-plan.mts",
  ])("requires authorization before credentialed E2E can execute %s", (file) => {
    expect(requiresCredentialedE2eAuthorization(plan(file))).toBe(true);
  });

  it("keeps mixed controller and credentialed execution changes behind authorization", () => {
    const result = plan(".github/workflows/pr-e2e-gate.yaml", "test/e2e/risk-signal-reporter.ts");

    expect(requiresCredentialedE2eAuthorization(result)).toBe(true);
  });

  it.each([
    "nemoclaw/src/blueprint/runner.ts",
    "nemoclaw-blueprint/blueprint.yaml",
    "agents/hermes/config/build.ts",
  ])("keeps the shared sandbox boundary in both agent and security floors: %s", (file) => {
    const result = plan(file);

    expect(result.families.map((family) => family.id)).toContain("sandbox-boundary");
    expect(riskPlanRequiredJobIds(result)).toEqual(
      expect.arrayContaining(["full-e2e", "hermes-e2e", "security-posture"]),
    );
  });

  it("keeps every required job selected for broad runtime changes (#6446)", () => {
    const result = plan(
      "src/lib/onboard.ts",
      "src/lib/actions/upgrade-sandboxes.ts",
      "src/lib/actions/sandbox/agents/apply.ts",
      "src/lib/messaging/applier/agent-config.ts",
      "src/lib/inference/health.ts",
      "install.sh",
      "src/lib/credentials/provider-list.ts",
    );

    expect(riskPlanRequiredJobIds(result)).toEqual([
      "cloud-onboard",
      "credential-sanitization",
      "security-posture",
      "channels-add-remove",
      "channels-stop-start",
      "full-e2e",
      "hermes-e2e",
      "inference-routing",
      "network-policy",
      "onboard-repair",
      "onboard-resume",
      "state-backup-restore",
      "upgrade-stale-sandbox",
    ]);
  });

  it("raises PR review test depth for a matched runtime risk", () => {
    const result = classifyTestDepth(["src/lib/state/registry.ts"]);

    expect(result.verdict).toBe("runtime_validation_recommended");
    expect(result.suggestedTests.join("\n")).toContain("onboard-resume");
    expect(result.suggestedTests.join("\n")).toContain("`src/lib/state/registry.ts`");
  });

  it("keeps every discovered test selector wired into the canonical E2E workflow", () => {
    const allowedJobs = new Set(readFreeStandingJobsInventory().allowedJobs);
    const configuredJobs = new Set(RISK_RULES.flatMap((rule) => rule.requiredJobs));

    expect([...configuredJobs].filter((job) => !allowedJobs.has(job))).toEqual([]);
  });
});
