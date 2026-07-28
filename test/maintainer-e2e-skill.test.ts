// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateFullE2eEvidence } from "../.agents/skills/nemoclaw-maintainer-e2e/scripts/validate-full-e2e-evidence.mts";

const candidateSha = "a".repeat(40);

function validEvidence() {
  return {
    candidateSha,
    cleanup: {
      status: "ABSENT",
      verifiedAt: "2026-07-24T12:00:00Z",
      workspaceId: "workspace-123",
      workspaceName: "nclaw-e2e-100-2",
    },
    dispatch: {
      candidateSha,
      defaultSuiteSelected: true,
      eventName: "workflow_dispatch",
      includeStagingBrevLaunchable: true,
      jobs: "",
      kind: "nemoclaw-e2e-dispatch-v1",
      targets: "",
      workflowRunAttempt: 2,
      workflowRunId: "100",
    },
    jobs: {
      jobs: [
        {
          conclusion: "success",
          html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/100/job/200",
          name: "Exact staging Brev Launchable",
          run_attempt: 2,
          status: "completed",
        },
      ],
    },
    launchableE2e: {
      boot: {
        provisionSha: candidateSha,
        repoClean: true,
        repoSha: candidateSha,
      },
      candidateSha,
      fullE2e: "passed",
      producer: { runId: "99", status: "success" },
      workspace: { id: "workspace-123", name: "nclaw-e2e-100-2" },
    },
    run: {
      conclusion: "success",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: candidateSha,
      html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/100",
      id: 100,
      path: ".github/workflows/e2e.yaml",
      run_attempt: 2,
      status: "completed",
    },
  };
}

describe("nemoclaw-maintainer-e2e evidence validation", () => {
  it("returns exact-candidate job, Launchable E2E, and cleanup evidence (#7487)", () => {
    expect(validateFullE2eEvidence(validEvidence())).toEqual({
      attempt: 2,
      candidateSha,
      cleanup: {
        status: "ABSENT",
        verifiedAt: "2026-07-24T12:00:00Z",
        workspaceId: "workspace-123",
        workspaceName: "nclaw-e2e-100-2",
      },
      dispatch: {
        defaultSuiteSelected: true,
        includeStagingBrevLaunchable: true,
      },
      jobUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/100/job/200",
      launchableE2e: {
        fullE2e: "passed",
        producerRunId: "99",
        provisionSha: candidateSha,
        repoClean: true,
        repoSha: candidateSha,
      },
      runUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/100",
    });
  });

  it.each([
    [
      "a run for another SHA",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.run.head_sha = "b".repeat(40);
      },
      "run.head_sha",
    ],
    [
      "a selective Launchable E2E dispatch",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.dispatch.defaultSuiteSelected = false;
        evidence.dispatch.includeStagingBrevLaunchable = false;
        evidence.dispatch.jobs = "staging-brev-launchable";
      },
      "dispatch.jobs",
    ],
    [
      "a skipped Launchable E2E job",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.jobs.jobs[0]!.conclusion = "skipped";
      },
      "Exact staging Brev Launchable conclusion",
    ],
    [
      "a Launchable E2E receipt for another SHA",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.launchableE2e.boot.repoSha = "b".repeat(40);
      },
      "launchableE2e.boot.repoSha",
    ],
    [
      "a cleanup receipt without verified absence",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.cleanup.status = "PRESENT";
      },
      "cleanup.status",
    ],
    [
      "a job from another attempt",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.jobs.jobs[0]!.run_attempt = 1;
      },
      "Exact staging Brev Launchable run_attempt",
    ],
  ])("rejects %s (#7487)", (_name, mutate, message) => {
    const evidence = validEvidence();
    mutate(evidence);

    expect(() => validateFullE2eEvidence(evidence)).toThrow(message);
  });

  it.each([
    [
      "a missing cleanup receipt",
      (evidence: ReturnType<typeof validEvidence>) => ({ ...evidence, cleanup: undefined }),
      "cleanup must be an object",
    ],
    [
      "a non-object dispatch receipt",
      (evidence: ReturnType<typeof validEvidence>) => ({ ...evidence, dispatch: "invalid" }),
      "dispatch must be an object",
    ],
    [
      "a non-object jobs response",
      (evidence: ReturnType<typeof validEvidence>) => ({ ...evidence, jobs: [] }),
      "jobs response must be an object",
    ],
  ])("rejects %s (#7487)", (_name, malformedEvidence, message) => {
    expect(() => validateFullE2eEvidence(malformedEvidence(validEvidence()))).toThrow(message);
  });
});

describe("nemoclaw-maintainer-e2e workflow routing", () => {
  const skill = fs.readFileSync(
    path.join(process.cwd(), ".agents", "skills", "nemoclaw-maintainer-e2e", "SKILL.md"),
    "utf8",
  );

  it("keeps ordinary and billable full requests distinct (#7487)", () => {
    expect(skill).toContain("Run the E2E suite");
    expect(skill).toContain("include_staging_brev_launchable=false");
    expect(skill).toContain("Run the full E2E suite");
    expect(skill).toContain("include_staging_brev_launchable=true");
    expect(skill).toContain("deploy pre-release full E2E");
    expect(skill).toContain("run pre-tag full E2E");
    expect(skill).toContain("run release-candidate E2E");
    expect(skill).toContain("must not authorize the protected Brev path");
    expect(skill).not.toMatch(/variable (?:set|delete) NEMOCLAW_BREV_LAUNCHABLE_E2E_ENABLED/u);
  });

  it("binds dispatch, evidence, invalidation, and release handoff to one SHA (#7487)", () => {
    expect(skill).toContain("git rev-parse origin/main");
    expect(skill).toContain("correlation_id=${CORRELATION_ID}");
    expect(skill).toContain("head_sha");
    expect(skill).toContain("Exact staging Brev Launchable");
    expect(skill).toContain("launchable-e2e.json");
    expect(skill).toContain("cleanup.json");
    expect(skill).toContain("dispatch.json");
    expect(skill).toContain("validate-full-e2e-evidence.mts");
    expect(skill).toContain("provisional release evidence");
    expect(skill).toContain("If the release candidate SHA changes");
    expect(skill).toContain("nemoclaw-maintainer-cut-release-tag");
  });
});
