// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validatePrReviewAdvisorWorkflowBoundary } from "../tools/pr-review-advisor/workflow-boundary.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

function prepareTargetCheckoutScript(): string {
  return workflowStepScript("Prepare target PR checkout");
}

function workflowStepScript(name: string): string {
  const workflow = YAML.parse(
    fs.readFileSync(path.join(ROOT, ".github/workflows/pr-review-advisor.yaml"), "utf8"),
  ) as { jobs?: { review?: { steps?: Array<{ name?: string; run?: string }> } } };
  const step = workflow.jobs?.review?.steps?.find((candidate) => candidate.name === name);
  expect(step?.run).toEqual(expect.any(String));
  return step!.run!;
}

function writeFakeCommand(binDir: string, name: string): void {
  fs.writeFileSync(
    path.join(binDir, name),
    `#!/bin/bash\nprintf '${name} %s\\n' "$*" >> "$CALL_LOG"\n`,
    { mode: 0o755 },
  );
}

function runPrepareTargetCheckout(env: {
  TARGET_REPO: string;
  TARGET_PR: string;
  TARGET_BASE: string;
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-workflow-"));
  const binDir = path.join(tmp, "bin");
  const gitLog = path.join(tmp, "git.log");
  const githubEnv = path.join(tmp, "github-env");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "git"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$FAKE_GIT_LOG"\n',
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", prepareTargetCheckoutScript()], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      FAKE_GIT_LOG: gitLog,
      GITHUB_ENV: githubEnv,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
  return {
    ...result,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    gitCalls: fs.existsSync(gitLog) ? fs.readFileSync(gitLog, "utf8").trim().split(/\r?\n/u) : [],
    githubEnv: fs.existsSync(githubEnv) ? fs.readFileSync(githubEnv, "utf8") : "",
  };
}

describe("PR review advisor workflow boundary", () => {
  it("installs the grep dependency when the trusted runner lacks it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-install-"));
    const binDir = path.join(tmp, "bin");
    const callLog = path.join(tmp, "calls.log");
    const rgTemplate = path.join(tmp, "rg-template");
    fs.mkdirSync(binDir);
    for (const name of ["npm", "rm", "ln"]) writeFakeCommand(binDir, name);
    fs.writeFileSync(rgTemplate, '#!/bin/bash\nprintf \'rg %s\\n\' "$*" >> "$CALL_LOG"\n', {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(binDir, "sudo"),
      `#!/bin/bash
printf 'sudo %s\\n' "$*" >> "$CALL_LOG"
if [[ "$*" == *"apt-get install"* ]]; then
  /bin/cp "$RG_TEMPLATE" "$FAKE_BIN/rg"
  /bin/chmod +x "$FAKE_BIN/rg"
fi
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("/bin/bash", ["-c", workflowStepScript("Install Pi SDK")], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          ADVISOR_DIR: path.join(tmp, "advisor"),
          CALL_LOG: callLog,
          FAKE_BIN: binDir,
          PATH: binDir,
          PI_SDK_VERSION: "test-version",
          RIPGREP_VERSION: "14.1.0-1",
          RG_TEMPLATE: rgTemplate,
          RUNNER_TEMP: path.join(tmp, "runner"),
        },
      });
      const calls = fs.readFileSync(callLog, "utf8").trim().split(/\r?\n/u);

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual(
        expect.arrayContaining([
          "sudo apt-get update -qq",
          "sudo apt-get install -y --no-install-recommends ripgrep=14.1.0-1",
          "rg --version",
          expect.stringMatching(/^npm install .*--ignore-scripts/u),
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the workflow inside the trusted-code boundary", () => {
    expect(validatePrReviewAdvisorWorkflowBoundary()).toEqual([]);
  });

  it("rejects a workflow that masks an incomplete advisor analysis", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-outcome-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = YAML.parse(
      fs.readFileSync(path.join(ROOT, ".github/workflows/pr-review-advisor.yaml"), "utf8"),
    ) as { jobs: { review: { steps: Array<{ name?: string }> } } };
    workflow.jobs.review.steps = workflow.jobs.review.steps.filter(
      (step) => step.name !== "Verify advisor analysis outcome",
    );
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validatePrReviewAdvisorWorkflowBoundary(workflowPath)).toEqual([
        "missing workflow step: Verify advisor analysis outcome",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an outcome check whose failure is ignored", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-outcome-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = YAML.parse(
      fs.readFileSync(path.join(ROOT, ".github/workflows/pr-review-advisor.yaml"), "utf8"),
    ) as {
      jobs: { review: { steps: Array<{ name?: string; "continue-on-error"?: boolean }> } };
    };
    const outcome = workflow.jobs.review.steps.find(
      (step) => step.name === "Verify advisor analysis outcome",
    );
    outcome!["continue-on-error"] = true;
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validatePrReviewAdvisorWorkflowBoundary(workflowPath)).toEqual([
        "Verify advisor analysis outcome must not continue on error",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an unpinned runtime package fallback", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-boundary-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = YAML.parse(
      fs.readFileSync(path.join(ROOT, ".github/workflows/pr-review-advisor.yaml"), "utf8"),
    ) as { jobs: { review: { steps: Array<{ name?: string; run?: string }> } } };
    const install = workflow.jobs.review.steps.find((step) => step.name === "Install Pi SDK");
    install!.run = install!.run!.replace('"ripgrep=${RIPGREP_VERSION}"', "ripgrep");
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validatePrReviewAdvisorWorkflowBoundary(workflowPath)).toEqual([
        "step 'Install Pi SDK' run script must include sudo apt-get install -y --no-install-recommends \"ripgrep=${RIPGREP_VERSION}\"",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects malformed manual target inputs before invoking git", () => {
    const invalidCases = [
      {
        TARGET_REPO: "NVIDIA/NemoClaw --upload-pack=x",
        TARGET_PR: "5756",
        TARGET_BASE: "main",
      },
      { TARGET_REPO: "NVIDIA/NemoClaw", TARGET_PR: "12:refs/heads/x", TARGET_BASE: "main" },
      {
        TARGET_REPO: "NVIDIA/NemoClaw",
        TARGET_PR: "5756",
        TARGET_BASE: "main:refs/heads/x",
      },
      { TARGET_REPO: "NVIDIA/NemoClaw", TARGET_PR: "5756", TARGET_BASE: "../main" },
      { TARGET_REPO: "NVIDIA/NemoClaw", TARGET_PR: "5756", TARGET_BASE: "-main" },
    ];

    for (const invalid of invalidCases) {
      const result = runPrepareTargetCheckout(invalid);
      try {
        expect(result.status).toBe(1);
        expect(result.gitCalls).toEqual([]);
      } finally {
        result.cleanup();
      }
    }

    const valid = runPrepareTargetCheckout({
      TARGET_REPO: "NVIDIA/NemoClaw",
      TARGET_PR: "5756",
      TARGET_BASE: "main",
    });
    try {
      expect(valid.status).toBe(0);
      expect(valid.gitCalls).toEqual([
        "-C /tmp/pr-review-advisor-target init",
        "-C /tmp/pr-review-advisor-target remote add target https://github.com/NVIDIA/NemoClaw.git",
        "-C /tmp/pr-review-advisor-target fetch --no-tags target main",
        "-C /tmp/pr-review-advisor-target fetch --no-tags target pull/5756/head:refs/remotes/target/pr-5756",
        "-C /tmp/pr-review-advisor-target checkout --detach refs/remotes/target/pr-5756",
      ]);
      expect(valid.githubEnv).toBe(
        "ADVISOR_WORKDIR=/tmp/pr-review-advisor-target\nPR_NUMBER=5756\n",
      );
    } finally {
      valid.cleanup();
    }
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
          "Run PR review advisor must continue-on-error until summaries, comments, and artifacts are published",
          "missing workflow step: Verify advisor analysis outcome",
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
