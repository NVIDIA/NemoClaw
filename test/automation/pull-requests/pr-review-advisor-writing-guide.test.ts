// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRiskPlan } from "../../../tools/advisors/risk-plan.mts";

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
      const { readTrustedWritingGuide } =
        await import("../../../tools/pr-review-advisor/trusted-guidance.mts");
      const writingGuide = readTrustedWritingGuide();

      expect(writingGuide).toContain("# NemoClaw Writing Guide");
      expect(writingGuide).not.toContain("PR-controlled writing guide");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(prWorktree, { recursive: true, force: true });
    }
  });

  it("stops when the trusted guide is unavailable", async () => {
    const { readTrustedWritingGuide } =
      await import("../../../tools/pr-review-advisor/trusted-guidance.mts");
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("missing guide fixture");
    });

    expect(() => readTrustedWritingGuide()).toThrow("Writing guide unavailable");
  });

  it("writes failure artifacts when the trusted security rubric is unavailable", async () => {
    const { preparePromptArtifacts } = await import("../../../tools/pr-review-advisor/analyze.mts");
    const { artifactPaths } = await import("../../../tools/pr-review-advisor/artifacts.mts");
    const outDir = fs.mkdtempSync(path.join(tmpdir(), "advisor-rubric-failure-"));
    const headSha = "b".repeat(40);
    const realReadFileSync = fs.readFileSync.bind(fs);
    const rejectRubricRead = () => {
      throw new Error("missing rubric fixture");
    };
    const readSpy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(((file, ...args) =>
        String(file).endsWith(`${path.sep}security-rubric.md`)
          ? rejectRubricRead()
          : realReadFileSync(file, ...args)) as typeof fs.readFileSync);
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
        github: null,
      },
    };

    try {
      expect(() =>
        preparePromptArtifacts({
          artifacts: artifactPaths(outDir),
          metadata,
          diff: "",
        }),
      ).toThrow("Security rubric unavailable");
      readSpy.mockRestore();

      expect(
        JSON.parse(fs.readFileSync(path.join(outDir, "pr-review-advisor-result.json"), "utf8")),
      ).toMatchObject({
        failed: true,
        reason: expect.stringContaining("Security rubric unavailable"),
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(outDir, "pr-review-advisor-final-result.json"), "utf8"),
        ),
      ).toMatchObject({
        headSha,
        reviewCompleteness: { requiresHumanReview: true },
      });
    } finally {
      readSpy.mockRestore();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("writes failure artifacts when trusted prompt inputs are unavailable", async () => {
    const { preparePromptArtifacts } = await import("../../../tools/pr-review-advisor/analyze.mts");
    const { artifactPaths } = await import("../../../tools/pr-review-advisor/artifacts.mts");
    const { readTrustedSecurityRubric } =
      await import("../../../tools/pr-review-advisor/trusted-guidance.mts");
    const outDir = fs.mkdtempSync(path.join(tmpdir(), "advisor-prompt-failure-"));
    const headSha = "a".repeat(40);
    const securityRubric = readTrustedSecurityRubric();
    const rejectWritingGuideRead = () => {
      throw new Error("missing guide fixture");
    };
    const readSpy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation((file) =>
        String(file).endsWith(`${path.sep}WRITING.md`) ? rejectWritingGuideRead() : securityRubric,
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
        github: null,
      },
    };

    try {
      expect(() =>
        preparePromptArtifacts({
          artifacts: artifactPaths(outDir),
          metadata,
          diff: "",
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
