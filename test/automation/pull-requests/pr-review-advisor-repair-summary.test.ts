// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAttemptReceipt } from "../../../tools/pr-review-advisor-repair/audit.mts";
import {
  parseProposalReceipt,
  parseSelectionInput,
  selectRepairAttempt,
  type ValidationReceipt,
} from "../../../tools/pr-review-advisor-repair/contract.mts";
import {
  appendAttemptJobSummary,
  appendGeneratedHeadJobSummary,
  appendProposalJobSummary,
  appendPublicationJobSummary,
  appendRepairJobSummary,
  appendSelectionJobSummary,
  appendValidationJobSummary,
} from "../../../tools/pr-review-advisor-repair/summary.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-summary-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function selection(summary: string) {
  const head = "a".repeat(40);
  return selectRepairAttempt(
    parseSelectionInput({
      version: 1,
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      pullRequest: {
        state: "open",
        draft: false,
        author: "contributor",
        baseRef: "main",
        headRepository: "NVIDIA/NemoClaw",
        headRef: summary,
        maintainerCanModify: true,
      },
      sourceHeadSha: head,
      baseSha: "b".repeat(40),
      advisor: {
        workflowSha: "c".repeat(40),
        runId: 700,
        runAttempt: 2,
        artifactIds: Array.from({ length: 10 }, (_value, index) => index + 100),
      },
      optIn: {
        kind: "phase1-maintainer-dispatch",
        actor: "maintainer",
        triggeringActor: "maintainer",
        headSha: head,
      },
      productScope: { kind: "maintainer-decision", identity: summary },
      findings: [
        {
          id: "behavior:001",
          repairClass: "source",
          summary,
          path: "src/demo.ts",
          exclusions: [],
        },
      ],
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("PR Review Advisor repair job summaries", () => {
  it("reports trusted receipts without rendering untrusted fields (#10791)", () => {
    const summaryFile = path.join(temporaryDirectory(), "job-summary.md");
    const sentinel = "UNTRUSTED_MARKDOWN_SENTINEL";
    const attempt = createAttemptReceipt({
      ADVISOR_RUN_ID: "700",
      FINDINGS_JSON: JSON.stringify([{ summary: sentinel }]),
      GITHUB_ACTOR: "maintainer",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "900",
      GITHUB_TRIGGERING_ACTOR: "maintainer",
      GITHUB_WORKFLOW_SHA: "d".repeat(40),
      PHASE1_ENABLED: "true",
      REPOSITORY_EGRESS_AUTHORIZED: "true",
      PR_NUMBER: "42",
      PRODUCT_SCOPE_IDENTITY: sentinel,
      PRODUCT_SCOPE_KIND: "maintainer-decision",
    });
    const bundle = selection(sentinel);
    const proposal = parseProposalReceipt(
      {
        version: 1,
        attemptKey: bundle.attemptKey,
        sourceHeadSha: bundle.input.sourceHeadSha,
        findingIds: bundle.selectedFindingIds,
        unresolvedFindingIds: [],
        changedPaths: ["src/demo.ts"],
        summary: sentinel,
        outcome: "proposed",
      },
      bundle,
    );
    const digest = `sha256:${"1".repeat(64)}`;
    const validation: ValidationReceipt = {
      version: 1,
      attemptKey: bundle.attemptKey,
      repository: "NVIDIA/NemoClaw",
      prNumber: bundle.input.prNumber,
      author: bundle.input.pullRequest.author,
      headRef: sentinel,
      sourceHeadSha: bundle.input.sourceHeadSha,
      baseSha: bundle.input.baseSha,
      advisor: bundle.input.advisor,
      findingIds: bundle.selectedFindingIds,
      selectedPaths: bundle.selectedPaths,
      patchSha256: "e".repeat(64),
      candidateTreeSha: "f".repeat(40),
      changedPaths: [{ path: "src/demo.ts", status: "M", mode: "100644", type: "blob", bytes: 24 }],
      validation: {
        candidateDigestBefore: digest,
        candidateDigestAfter: digest,
        commands: [{ argv: ["npm", "run", "check:diff"], exitCode: 0 }],
      },
      productScope: bundle.input.productScope,
      optIn: bundle.input.optIn,
      outcome: "rejected",
      reason: sentinel,
    };
    const publication = {
      attemptKey: bundle.attemptKey,
      sourceHeadSha: bundle.input.sourceHeadSha,
      candidateTreeSha: "f".repeat(40),
      commitSha: "d".repeat(40),
      headRef: sentinel,
      dispatchedWorkflows: ["pr.yaml", "pr-review-advisor.yaml"],
    };

    appendAttemptJobSummary(summaryFile, attempt);
    appendSelectionJobSummary(summaryFile, bundle);
    appendProposalJobSummary(summaryFile, proposal);
    appendValidationJobSummary(summaryFile, validation);
    appendPublicationJobSummary(summaryFile, publication);
    appendGeneratedHeadJobSummary(summaryFile, bundle.attemptKey, publication.commitSha);

    const rendered = fs.readFileSync(summaryFile, "utf8");
    expect(rendered).toContain("PR Review Advisor repair — attempt gate");
    expect(rendered).toContain("PR Review Advisor repair — generated-head gates");
    expect(rendered).toContain("`rejected`");
    expect(rendered).not.toContain(sentinel);
    expect(rendered).not.toContain("src/demo.ts");
  });

  it("refuses to follow a job-summary symlink (#10791)", () => {
    const root = temporaryDirectory();
    const target = path.join(root, "target.md");
    const link = path.join(root, "summary.md");
    fs.writeFileSync(target, "unchanged\n");
    fs.symlinkSync(target, link);

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const receipt = createAttemptReceipt({
      ADVISOR_RUN_ID: "700",
      FINDINGS_JSON: "[]",
      GITHUB_ACTOR: "maintainer",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "900",
      GITHUB_TRIGGERING_ACTOR: "maintainer",
      GITHUB_WORKFLOW_SHA: "d".repeat(40),
      PHASE1_ENABLED: "false",
      PR_NUMBER: "42",
      PRODUCT_SCOPE_IDENTITY: "10791",
      PRODUCT_SCOPE_KIND: "accepted-issue",
    });

    expect(() => appendRepairJobSummary(link, "safe summary\n")).toThrow();
    expect(() => appendAttemptJobSummary(link, receipt)).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      "PR Review Advisor repair job summary could not be written",
    );
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged\n");
  });
});
