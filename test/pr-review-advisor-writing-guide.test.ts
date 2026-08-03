// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRiskPlan } from "../tools/advisors/risk-plan.mts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PR Review Advisor writing guide", () => {
  it("loads the guide from the advisor checkout", async () => {
    const originalCwd = process.cwd();
    const prWorktree = fs.mkdtempSync(path.join(tmpdir(), "advisor-writing-guide-"));
    fs.writeFileSync(path.join(prWorktree, "WRITING.md"), "# PR-controlled writing guide\n");

    try {
      process.chdir(prWorktree);
      const { readTrustedWritingGuide } = await import("../tools/pr-review-advisor/analyze.mts");
      const writingGuide = readTrustedWritingGuide();

      expect(writingGuide).toContain("# NemoClaw Writing Guide");
      expect(writingGuide).not.toContain("PR-controlled writing guide");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(prWorktree, { recursive: true, force: true });
    }
  });

  it("stops when the trusted guide is unavailable", async () => {
    const { readTrustedWritingGuide } = await import("../tools/pr-review-advisor/analyze.mts");
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("missing guide fixture");
    });

    expect(() => readTrustedWritingGuide()).toThrow("Writing guide unavailable");
  });

  it("writes failure artifacts when trusted prompt inputs are unavailable", async () => {
    const { artifactPaths, preparePromptArtifacts, readTrustedSecurityReviewSkill } = await import(
      "../tools/pr-review-advisor/analyze.mts"
    );
    const { createReviewFindingLedger } = await import(
      "../tools/pr-review-advisor/review-ledger.mts"
    );
    const { createTerminologyLedger } = await import("../tools/pr-review-advisor/terminology.mts");
    const outDir = fs.mkdtempSync(path.join(tmpdir(), "advisor-prompt-failure-"));
    const headSha = "a".repeat(40);
    const securitySkill = readTrustedSecurityReviewSkill();
    const rejectWritingGuideRead = () => {
      throw new Error("missing guide fixture");
    };
    const readSpy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation((file) =>
        String(file).endsWith(`${path.sep}WRITING.md`) ? rejectWritingGuideRead() : securitySkill,
      );
    const metadata = {
      baseRef: "origin/main",
      headRef: "HEAD",
      headSha,
      changedFiles: [],
      deterministic: {
        diffStat: "",
        commits: [],
        riskyAreas: [],
        riskPlan: buildRiskPlan({ headSha, changedFiles: [] }),
        testDepth: { verdict: "unknown" as const, rationale: "Not analyzed.", suggestedTests: [] },
        staticTestInventory: {
          changedTestFiles: [],
          nearbyTestNames: [],
          candidateExistingCoverage: [],
        },
        simplificationSignals: [],
        workflowSignals: [],
        localizedPatchSignals: [],
        driftEvidence: [],
        previousAdvisorReview: null,
        github: null,
      },
    };

    try {
      expect(() =>
        preparePromptArtifacts({
          artifacts: artifactPaths(outDir),
          metadata,
          diff: "",
          schema: {},
          findingLedger: createReviewFindingLedger(),
          terminologyLedger: createTerminologyLedger(headSha),
        }),
      ).toThrow("Writing guide unavailable");
      readSpy.mockRestore();

      expect(
        JSON.parse(fs.readFileSync(path.join(outDir, "pr-review-advisor-result.json"), "utf8")),
      ).toMatchObject({
        failed: true,
        reason: expect.stringContaining("Writing guide unavailable"),
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(outDir, "pr-review-advisor-final-result.json"), "utf8"),
        ),
      ).toMatchObject({
        headSha,
        terminologyReview: { status: "limited", decisions: [] },
        reviewCompleteness: { requiresHumanReview: true },
      });
    } finally {
      readSpy.mockRestore();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
