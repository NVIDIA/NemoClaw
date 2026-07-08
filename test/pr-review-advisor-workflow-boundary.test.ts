// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePrReviewAdvisorWorkflowBoundary } from "../tools/pr-review-advisor/workflow-boundary.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("PR review advisor workflow boundary", () => {
  it("keeps the workflow inside the trusted-code boundary", () => {
    expect(validatePrReviewAdvisorWorkflowBoundary()).toEqual([]);
  });

  it("flags advisor matrix isolation workflow regressions", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = fs
      .readFileSync(path.join(ROOT, ".github", "workflows", "pr-review-advisor.yaml"), "utf-8")
      .replace(
        'comment_marker: "<!-- nemoclaw-pr-review-advisor-nemotron-ultra -->"',
        'comment_marker: "<!-- nemoclaw-pr-review-advisor -->"',
      )
      .replace("artifact_dir: pr-review-advisor-nemotron-ultra", "artifact_dir: pr-review-advisor")
      .replace(
        "artifact_name: pr-review-advisor-nemotron-ultra",
        "artifact_name: pr-review-advisor",
      )
      .replace("model: nvidia/nvidia/nemotron-3-ultra", "model: openai/openai/gpt-5.5")
      .replace('\n              --title "$PR_REVIEW_ADVISOR_COMMENT_TITLE" \\', "");
    fs.writeFileSync(workflowPath, workflow);

    try {
      const errors = validatePrReviewAdvisorWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "advisor matrix field model must be unique: openai/openai/gpt-5.5",
          "advisor matrix field artifact_dir must be unique: pr-review-advisor",
          "advisor matrix field artifact_name must be unique: pr-review-advisor",
          "advisor matrix field comment_marker must be unique: <!-- nemoclaw-pr-review-advisor -->",
          "step 'Post PR review advisor comment' run script must include --title \"$PR_REVIEW_ADVISOR_COMMENT_TITLE\"",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags trusted-code boundary workflow regressions", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    fs.writeFileSync(
      workflowPath,
      `
"on":
  pull_request_target: {}
permissions:
  contents: write
jobs:
  review:
    continue-on-error: true
    steps:
      - name: Checkout trusted advisor code (main)
        uses: actions/checkout@v4
        with:
          repository: NVIDIA/NemoClaw
          ref: main
          path: advisor
          persist-credentials: true
      - name: Checkout PR workspace (read-only data)
        uses: actions/checkout@0123456789abcdef0123456789abcdef01234567
        with:
          ref: refs/pull/\${{ github.event.pull_request.head.sha }}/merge
          path: pr-workdir
          persist-credentials: false
      - name: Run PR review advisor
        env:
          PR_REVIEW_ADVISOR_API_KEY: \${{ secrets.PR_REVIEW_ADVISOR_API_KEY || secrets.PI_PR_REVIEW_ADVISOR_API_KEY }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
        run: |
          cd "$ADVISOR_WORKDIR"
          node "$ADVISOR_DIR/tools/pr-review-advisor/analyze.mts" --schema "$ADVISOR_DIR/tools/pr-review-advisor/schema.json"
`,
    );

    try {
      const errors = validatePrReviewAdvisorWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "workflow must run on pull_request, not only trusted-target events",
          "workflow must not run untrusted PR code under pull_request_target",
          "workflow permissions.contents must be read",
          "review job must not be globally continue-on-error",
          "PR checkout must use the pull request head SHA as inert analysis data",
          "Run PR review advisor must receive PR_REVIEW_ADVISOR_API_KEY only from secrets.PR_REVIEW_ADVISOR_API_KEY",
          "Run PR review advisor must not receive OPENAI_API_KEY",
        ]),
      );
      expect(errors.some((error) => error.includes("full commit SHA"))).toBe(true);
      expect(errors.some((error) => error.includes("persist-credentials=false"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes low-confidence skip artifacts for unsupported trusted-main rollout skew", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-skip-"));
    const outDir = path.join(tmp, "artifacts", "pr-review-advisor-nemotron-ultra");
    const reason =
      "Trusted main checkout does not yet support advisor model nvidia/nvidia/nemotron-3-ultra; this parallel advisor will run after the implementation lands on main.";

    try {
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          path.join(ROOT, "tools", "pr-review-advisor", "analyze.mts"),
          "--base",
          "HEAD",
          "--head",
          "HEAD",
          "--schema",
          path.join(ROOT, "tools", "pr-review-advisor", "schema.json"),
          "--out-dir",
          outDir,
        ],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            PR_REVIEW_ADVISOR_RUN_ANALYSIS: "0",
            PR_REVIEW_ADVISOR_UNAVAILABLE_REASON: reason,
            PR_NUMBER: "",
            GH_TOKEN: "",
            GITHUB_TOKEN: "",
          },
          stdio: "pipe",
        },
      );

      const raw = JSON.parse(
        fs.readFileSync(path.join(outDir, "pr-review-advisor-result.json"), "utf-8"),
      );
      const final = JSON.parse(
        fs.readFileSync(path.join(outDir, "pr-review-advisor-final-result.json"), "utf-8"),
      );
      const summary = fs.readFileSync(path.join(outDir, "pr-review-advisor-summary.md"), "utf-8");
      expect(raw).toMatchObject({ skipped: true, reason });
      expect(final.summary).toMatchObject({ recommendation: "info_only", confidence: "low" });
      expect(final.summary.oneLine).toContain(reason);
      expect(summary).toContain("# PR Review Advisor");
      expect(summary).toContain(reason);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports workflow parse failures through boundary errors", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-missing-"));
    const missingPath = path.join(tmp, "workflow.yaml");
    try {
      expect(validatePrReviewAdvisorWorkflowBoundary(missingPath)).toEqual([
        `failed to read or parse workflow: ${missingPath}`,
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
