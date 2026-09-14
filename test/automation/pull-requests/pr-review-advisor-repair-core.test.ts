// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildAdvisorFindingLedger } from "../../../tools/pr-review-advisor/finding-ledger.mts";
import {
  allowedRepairPath,
  bindRepairSelection,
  selectRepairFindings,
} from "../../../tools/pr-review-advisor/repair-contract.mts";
import { selectedAdvisorArtifactIds } from "../../../tools/pr-review-advisor/repair-select.mts";
import { ADVISOR_INTERESTS } from "../../../tools/pr-review-advisor/specialist-catalog.mts";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const workflowSha = "c".repeat(40);

function ledgers() {
  return ADVISOR_INTERESTS.map((interest) =>
    buildAdvisorFindingLedger({
      headSha,
      interest,
      input:
        interest === "documentation-standard-work"
          ? {
              findings: [
                {
                  severity: "P1",
                  kind: "documentation",
                  summary: "The documented command is wrong.",
                  path: "docs/example.mdx",
                  line: 10,
                  impact: "Users run the wrong command.",
                  smallestSafeFix: "Correct the command.",
                  regressionTest: "Build the documentation.",
                  exclusions: [],
                },
              ],
              noFindingsReason: null,
            }
          : { findings: [], noFindingsReason: "No blocker in this specialist area." },
    }),
  );
}

describe("PR Review Advisor repair core", () => {
  it("selects only opted-in findings in the narrow repair allowlist (#10791)", () => {
    const findingLedgers = ledgers();
    const finding = findingLedgers.flatMap(({ findings }) => findings)[0]!;
    const selection = selectRepairFindings({
      version: 1,
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      sourceHeadSha: headSha,
      baseSha,
      headRef: "fix/example",
      repositoryId: "R_repo",
      author: "contributor",
      actor: "maintainer",
      triggeringActor: "maintainer",
      workflowSha,
      advisor: {
        runId: 77,
        runAttempt: 2,
        workflowSha,
        artifactIds: Array.from({ length: ADVISOR_INTERESTS.length + 1 }, (_, index) => index + 1),
      },
      stateDigest: `sha256:${"d".repeat(64)}`,
      reviewDigest: `sha256:${"e".repeat(64)}`,
      ledgers: findingLedgers,
      optedFindingIds: [finding.id],
      productScope: "accepted:#10791",
      optIn: "manual-exact-head",
    });

    expect(selection.findingIds).toEqual([finding.id]);
    expect(selection.selectedPaths).toEqual(["docs/example.mdx"]);
    expect(allowedRepairPath("docs/example.mdx")).toBe(true);
    expect(allowedRepairPath(".github/workflows/example.yaml")).toBe(false);
    expect(allowedRepairPath("test/e2e/live/example.test.ts")).toBe(false);
  });

  it("binds a separate repair run to one completed exact Advisor attempt (#10791)", () => {
    const findingLedgers = ledgers();
    const findingId = findingLedgers.flatMap(({ findings }) => findings)[0]!.id;
    const artifactNames = [
      "pr-review-advisor-context-77",
      ...ADVISOR_INTERESTS.map((interest) => `pr-review-specialist-${interest}-2`),
    ];
    const request = {
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      sourceHeadSha: headSha,
      sourceBaseSha: baseSha,
      workflowSha,
      actor: "maintainer",
      triggeringActor: "maintainer",
      currentRunId: 77,
      currentRunAttempt: 2,
      optedFindingIds: [findingId],
      pullRequest: {
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { ref: "fix/example", sha: headSha, repo: { full_name: "NVIDIA/NemoClaw" } },
        base: {
          ref: "main",
          sha: baseSha,
          repo: { full_name: "NVIDIA/NemoClaw", node_id: "R_repo" },
        },
      },
      sourceCommit: { commit: { message: "fix: correct example" } },
      advisorRun: {
        id: 77,
        run_attempt: 2,
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        path: ".github/workflows/pr-review-advisor.yaml",
        workflow_sha: workflowSha,
        repository: { full_name: "NVIDIA/NemoClaw" },
        pull_requests: [],
      },
      advisorWorkflowComparison: {
        status: "identical",
        base_commit: { sha: workflowSha },
        merge_base_commit: { sha: workflowSha },
      },
      artifacts: artifactNames.map((name, index) => ({
        id: index + 100,
        name,
        expired: false,
        workflow_run: { id: 77 },
      })),
      ledgers: findingLedgers,
      state: { pull: { state: "open" }, comments: [], reviewComments: [] },
      reviews: [],
      permissions: {
        actor: { permission: "write", role_name: "maintain" },
        triggeringActor: { permission: "admin", role_name: "admin" },
      },
    };

    expect(bindRepairSelection(request)).toMatchObject({
      sourceHeadSha: headSha,
      baseSha,
      findingIds: [findingId],
      workflowSha,
      advisor: { runId: 77, runAttempt: 2, workflowSha },
    });
    const olderAdvisorWorkflowSha = "d".repeat(40);
    expect(
      bindRepairSelection({
        ...request,
        advisorRun: { ...request.advisorRun, workflow_sha: olderAdvisorWorkflowSha },
        advisorWorkflowComparison: {
          status: "ahead",
          base_commit: { sha: olderAdvisorWorkflowSha },
          merge_base_commit: { sha: olderAdvisorWorkflowSha },
        },
      }),
    ).toMatchObject({
      workflowSha,
      advisor: { workflowSha: olderAdvisorWorkflowSha },
    });
    expect(() =>
      bindRepairSelection({
        ...request,
        advisorRun: { ...request.advisorRun, workflow_sha: olderAdvisorWorkflowSha },
        advisorWorkflowComparison: {
          status: "diverged",
          base_commit: { sha: olderAdvisorWorkflowSha },
          merge_base_commit: { sha: "e".repeat(40) },
        },
      }),
    ).toThrow("successful trusted workflow revision");
    expect(selectedAdvisorArtifactIds(request)).toEqual(
      request.artifacts.map(({ id }) => id).sort((left, right) => left - right),
    );
    expect(() =>
      selectedAdvisorArtifactIds({
        ...request,
        artifacts: request.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, expired: true } : artifact,
        ),
      }),
    ).toThrow("Advisor artifact set is incomplete");
    expect(() =>
      bindRepairSelection({
        ...request,
        advisorRun: { ...request.advisorRun, status: "in_progress", conclusion: null },
      }),
    ).toThrow("successful trusted workflow revision");
  });
});
