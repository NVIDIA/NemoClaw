// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validatePrReviewAdvisorWorkflowBoundary } from "../tools/pr-review-advisor/workflow-boundary.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/pr-review-advisor.yaml");
const TARGET_DIR = "/tmp/pr-review-advisor-target";
const HEAD_SHA = "b".repeat(40);
const BASE_SHA = "a".repeat(40);

type Workflow = {
  jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
};

function workflowSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

function workflowStepScript(job: string, name: string): string {
  const workflow = YAML.parse(workflowSource()) as Workflow;
  const step = workflow.jobs?.[job]?.steps?.find((candidate) => candidate.name === name);
  expect(step?.run).toEqual(expect.any(String));
  return step!.run!;
}

function validateMutation(mutate: (source: string) => string): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-boundary-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  fs.writeFileSync(workflowPath, mutate(workflowSource()));
  try {
    return validatePrReviewAdvisorWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeFakeCommand(binDir: string, name: string): void {
  fs.writeFileSync(
    path.join(binDir, name),
    `#!/bin/bash\nprintf '${name} %s\\n' "$*" >> "$CALL_LOG"\n`,
    { mode: 0o755 },
  );
}

function runPrepareWorkspace(
  env: Partial<{
    TARGET_REPO: string;
    TARGET_PR: string;
    TARGET_BASE: string;
    PR_BASE_SHA: string;
    EXPECTED_HEAD_SHA: string;
    FAKE_BASE_SHA: string;
    FAKE_HEAD_SHA: string;
  }>,
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-target-"));
  const binDir = path.join(tmp, "bin");
  const gitLog = path.join(tmp, "git.log");
  const githubEnv = path.join(tmp, "github-env");
  const targetDir = path.join(tmp, "target");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "git"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [[ "$*" == *"rev-parse refs/remotes/target/base"* ]]; then
  printf '%s\\n' "$FAKE_BASE_SHA"
elif [[ "$*" == *"rev-parse HEAD"* ]]; then
  printf '%s\\n' "$FAKE_HEAD_SHA"
fi
`,
    { mode: 0o755 },
  );
  const script = workflowStepScript("review", "Prepare isolated analysis workspace").replaceAll(
    TARGET_DIR,
    targetDir,
  );
  const result = spawnSync("/bin/bash", ["-c", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET_REPO: "NVIDIA/NemoClaw",
      TARGET_PR: "6736",
      TARGET_BASE: "main",
      PR_BASE_SHA: BASE_SHA,
      EXPECTED_HEAD_SHA: HEAD_SHA,
      FAKE_BASE_SHA: BASE_SHA,
      FAKE_HEAD_SHA: HEAD_SHA,
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
    targetDir,
  };
}

function runArtifactValidation(
  result: unknown,
  options: {
    summary?: string;
    liveHead?: string;
    liveBase?: string;
    symlinkResult?: boolean;
  } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-publish-"));
  const artifactDir = path.join(tmp, "artifacts");
  const binDir = path.join(tmp, "bin");
  const resultPath = path.join(artifactDir, "pr-review-advisor-final-result.json");
  fs.mkdirSync(artifactDir);
  fs.mkdirSync(binDir);
  if (options.symlinkResult) {
    const outside = path.join(tmp, "outside.json");
    fs.writeFileSync(outside, `${JSON.stringify(result)}\n`);
    fs.symlinkSync(outside, resultPath);
  } else {
    fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
  }
  fs.writeFileSync(
    path.join(artifactDir, "pr-review-advisor-summary.md"),
    options.summary ?? "# PR Review Advisor\n",
  );
  fs.writeFileSync(
    path.join(binDir, "gh"),
    '#!/bin/bash\ncase "$*" in *".base.sha"*) printf \'%s\\n\' "$FAKE_LIVE_BASE" ;; *) printf \'%s\\n\' "$FAKE_LIVE_HEAD" ;; esac\n',
    { mode: 0o755 },
  );
  const completed = spawnSync(
    "/bin/bash",
    ["-c", workflowStepScript("publish", "Validate primary advisor artifact")],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_HEAD_SHA: HEAD_SHA,
        FAKE_LIVE_BASE: options.liveBase ?? BASE_SHA,
        FAKE_LIVE_HEAD: options.liveHead ?? HEAD_SHA,
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PR_BASE_SHA: BASE_SHA,
        PR_NUMBER: "6736",
        PR_REVIEW_ADVISOR_MAX_RESULT_BYTES: "2097152",
        PR_REVIEW_ADVISOR_MAX_SUMMARY_BYTES: "1048576",
        PUBLISH_ARTIFACT_DIR: artifactDir,
        TRUSTED_WORKFLOW_SHA: "c".repeat(40),
      },
    },
  );
  return {
    ...completed,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

function validPrimaryResult(): Record<string, unknown> {
  return {
    version: 1,
    headSha: HEAD_SHA,
    summary: { recommendation: "merge_as_is" },
    findings: [],
    e2e: { coverage: { required: [] }, targets: { required: [] } },
  };
}

describe("PR review advisor workflow boundary", () => {
  it("keeps the target-event workflow inside the split privilege boundary", () => {
    expect(validatePrReviewAdvisorWorkflowBoundary()).toEqual([]);
  });

  it("rejects trigger and trusted-workflow identity regressions", () => {
    const errors = validateMutation((source) =>
      source
        .replace("  pull_request_target:\n", "  pull_request:\n")
        .replaceAll("ref: ${{ github.workflow_sha }}", "ref: main"),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "workflow must run automatic reviews on pull_request_target",
        "workflow must not duplicate automatic reviews on pull_request",
        "step 'Checkout trusted advisor code (workflow revision)' expected with.ref=${{ github.workflow_sha }}",
        "step 'Checkout trusted comment publisher (workflow revision)' expected with.ref=${{ github.workflow_sha }}",
      ]),
    );
  });

  it("rejects privilege-domain collapse", () => {
    const errors = validateMutation((source) =>
      source
        .replace("      pull-requests: read\n", "      pull-requests: write\n")
        .replace(
          "      PR_REVIEW_ADVISOR_WORKFLOW_PATH: .github/workflows/pr-review-advisor.yaml",
          "      PR_REVIEW_ADVISOR_WORKFLOW_PATH: .github/workflows/pr-review-advisor.yaml\n      PR_REVIEW_ADVISOR_API_KEY: ${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}\n      ADVISOR_WORKDIR: /tmp/pr-workdir",
        ),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "review job permissions.pull-requests must be read",
        "publish must be the only job with pull-requests: write",
        "publish job must not receive the advisor model credential",
        "publish job must not receive the untrusted analysis worktree",
      ]),
    );
  });

  it("requires every third-party action to be pinned to an immutable commit", () => {
    const errors = validateMutation((source) =>
      source.replace(
        "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        "actions/download-artifact@v8",
      ),
    );
    expect(errors.some((error) => error.includes("full commit SHA"))).toBe(true);
  });

  // source-shape-contract: security -- Exactly one advisor lane may perform write-capable PR comment publication
  it("requires one advisor lane to publish the PR comment", () => {
    const source = fs.readFileSync(WORKFLOW_PATH, "utf8");
    const noPrimary = validateMutation((workflow) =>
      workflow.replace("publish_comment: true", "publish_comment: false"),
    );
    const twoPrimaries = validateMutation((workflow) =>
      workflow.replace("publish_comment: false", "publish_comment: true"),
    );

    expect(source).toContain("publish_comment: true");
    expect(noPrimary).toContain("advisor matrix must identify exactly one primary artifact lane");
    expect(twoPrimaries).toContain(
      "advisor matrix must identify exactly one primary artifact lane",
    );
  });

  it("fetches and verifies the exact event base and head before exposing the worktree", () => {
    const result = runPrepareWorkspace({});
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(result.gitCalls).toEqual([
        `-C ${result.targetDir} init`,
        `-C ${result.targetDir} config core.hooksPath /dev/null`,
        `-C ${result.targetDir} config submodule.recurse false`,
        `-C ${result.targetDir} remote add target https://github.com/NVIDIA/NemoClaw.git`,
        `-C ${result.targetDir} fetch --no-tags --no-recurse-submodules target ${BASE_SHA}:refs/remotes/target/base`,
        `-C ${result.targetDir} fetch --no-tags --no-recurse-submodules target refs/pull/6736/head:refs/remotes/target/pr-6736`,
        `-C ${result.targetDir} rev-parse refs/remotes/target/base`,
        `-C ${result.targetDir} -c submodule.recurse=false checkout --detach refs/remotes/target/pr-6736`,
        `-C ${result.targetDir} rev-parse HEAD`,
      ]);
      expect(result.githubEnv).toBe(`ADVISOR_WORKDIR=${result.targetDir}\nPR_NUMBER=6736\n`);
    } finally {
      result.cleanup();
    }
  });

  it("fails closed when the fetched pull ref no longer matches the event head", () => {
    const result = runPrepareWorkspace({ FAKE_HEAD_SHA: "d".repeat(40) });
    try {
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Fetched pull ref does not match");
      expect(result.githubEnv).toBe("");
    } finally {
      result.cleanup();
    }
  });

  it("rejects malformed target inputs before invoking git", () => {
    const invalid = [
      { TARGET_REPO: "NVIDIA/NemoClaw --upload-pack=x" },
      { TARGET_PR: "12:refs/heads/x" },
      { TARGET_BASE: "../main" },
      { TARGET_BASE: "-main" },
      { PR_BASE_SHA: "not-a-sha" },
      { EXPECTED_HEAD_SHA: "HEAD" },
    ];
    for (const environment of invalid) {
      const result = runPrepareWorkspace(environment);
      try {
        expect(result.status).toBe(1);
        expect(result.gitCalls).toEqual([]);
      } finally {
        result.cleanup();
      }
    }
  });

  it("removes worktree symlinks without touching their targets", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-symlinks-"));
    const workdir = path.join(tmp, "workdir");
    const outside = path.join(tmp, "outside.txt");
    fs.mkdirSync(workdir);
    fs.writeFileSync(outside, "runner state");
    fs.writeFileSync(path.join(workdir, "regular.txt"), "repository data");
    fs.symlinkSync(outside, path.join(workdir, "escape"));
    try {
      const result = spawnSync(
        "/bin/bash",
        ["-c", workflowStepScript("review", "Remove symlinks from analysis workspace")],
        { encoding: "utf8", env: { ...process.env, ADVISOR_WORKDIR: workdir } },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(workdir, "escape"))).toBe(false);
      expect(fs.readFileSync(outside, "utf8")).toBe("runner state");
      expect(fs.readFileSync(path.join(workdir, "regular.txt"), "utf8")).toBe("repository data");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // source-shape-contract: security -- Symlink cleanup must remain exact and ordered after every untrusted workspace selection but before model credentials
  it("rejects deleting or weakening analysis-workspace symlink removal", () => {
    type MutableWorkflow = {
      jobs: { review: { steps: Array<{ name?: string; run?: string; shell?: string }> } };
    };
    const source = YAML.parse(workflowSource()) as MutableWorkflow;
    const cases: Array<{
      expected: string;
      mutate: (workflow: MutableWorkflow) => void;
    }> = [
      {
        expected: "missing workflow step: Remove symlinks from analysis workspace",
        mutate: (workflow) => {
          workflow.jobs.review.steps = workflow.jobs.review.steps.filter(
            (step) => step.name !== "Remove symlinks from analysis workspace",
          );
        },
      },
      {
        expected: "Remove symlinks from analysis workspace must use the bash shell",
        mutate: (workflow) => {
          const step = workflow.jobs.review.steps.find(
            (candidate) => candidate.name === "Remove symlinks from analysis workspace",
          );
          step!.shell = "sh";
        },
      },
      {
        expected:
          "Remove symlinks from analysis workspace must use the canonical fail-closed cleanup script",
        mutate: (workflow) => {
          const step = workflow.jobs.review.steps.find(
            (candidate) => candidate.name === "Remove symlinks from analysis workspace",
          );
          step!.run = step!.run!.replace("-type l -print0", "-type f -print0");
        },
      },
      {
        expected:
          "Remove symlinks from analysis workspace must use the canonical fail-closed cleanup script",
        mutate: (workflow) => {
          const step = workflow.jobs.review.steps.find(
            (candidate) => candidate.name === "Remove symlinks from analysis workspace",
          );
          step!.run = step!.run!.replace('rm -- "$link"', 'rm -- "$link" || true');
        },
      },
      {
        expected:
          "Remove symlinks from analysis workspace must run after workspace-selection step 'Prepare isolated analysis workspace'",
        mutate: (workflow) => {
          const steps = workflow.jobs.review.steps;
          const cleanupIndex = steps.findIndex(
            (step) => step.name === "Remove symlinks from analysis workspace",
          );
          const cleanup = steps.splice(cleanupIndex, 1)[0]!;
          const prepareIndex = steps.findIndex(
            (step) => step.name === "Prepare isolated analysis workspace",
          );
          steps.splice(prepareIndex, 0, cleanup);
        },
      },
      {
        expected:
          "analysis workspace symlinks must be removed before the model credential is exposed",
        mutate: (workflow) => {
          const steps = workflow.jobs.review.steps;
          const cleanupIndex = steps.findIndex(
            (step) => step.name === "Remove symlinks from analysis workspace",
          );
          const cleanup = steps.splice(cleanupIndex, 1)[0]!;
          const analysisIndex = steps.findIndex((step) => step.name === "Run PR review advisor");
          steps.splice(analysisIndex + 1, 0, cleanup);
        },
      },
      {
        expected:
          "Remove symlinks from analysis workspace must run after workspace-selection step 'Set default advisor workdir'",
        mutate: (workflow) => {
          const steps = workflow.jobs.review.steps;
          const cleanupIndex = steps.findIndex(
            (step) => step.name === "Remove symlinks from analysis workspace",
          );
          const cleanup = steps.splice(cleanupIndex, 1)[0]!;
          const defaultIndex = steps.findIndex(
            (step) => step.name === "Set default advisor workdir",
          );
          steps.splice(defaultIndex, 0, cleanup);
        },
      },
    ];

    for (const { expected, mutate } of cases) {
      const workflow = structuredClone(source);
      mutate(workflow);
      expect(validateMutation(() => YAML.stringify(workflow))).toContain(expected);
    }
  });

  it("installs the pinned grep dependency when the runner lacks it", () => {
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
      const result = spawnSync(
        "/bin/bash",
        ["-c", workflowStepScript("review", "Install Pi SDK")],
        {
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
            TYPEBOX_VERSION: "test-typebox-version",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(callLog, "utf8")).toContain(
        "sudo apt-get install -y --no-install-recommends ripgrep=14.1.0-1",
      );
      expect(fs.readFileSync(callLog, "utf8")).toContain("--ignore-scripts");
      expect(fs.readFileSync(callLog, "utf8")).toContain("typebox@test-typebox-version");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts a bounded same-head primary artifact for publication", () => {
    const result = runArtifactValidation(validPrimaryResult());
    try {
      expect(result.status, result.stderr).toBe(0);
    } finally {
      result.cleanup();
    }
  });

  it("rejects malformed, wrong-head, stale, and symlinked publication artifacts", () => {
    const cases = [
      { name: "version", artifact: { ...validPrimaryResult(), version: 2 } },
      { name: "head", artifact: { ...validPrimaryResult(), headSha: "d".repeat(40) } },
      { name: "findings", artifact: { ...validPrimaryResult(), findings: null } },
      { name: "e2e", artifact: { ...validPrimaryResult(), e2e: {} } },
      { name: "live head", artifact: validPrimaryResult(), liveHead: "e".repeat(40) },
      { name: "live base", artifact: validPrimaryResult(), liveBase: "e".repeat(40) },
      { name: "symlink", artifact: validPrimaryResult(), symlinkResult: true },
    ];
    for (const { name, artifact, liveHead, liveBase, symlinkResult } of cases) {
      const result = runArtifactValidation(artifact, { liveHead, liveBase, symlinkResult });
      try {
        expect(result.status, `${name}: ${result.stdout}${result.stderr}`).toBe(1);
      } finally {
        result.cleanup();
      }
    }
  });

  it("rejects cross-run artifact downloads and missing publication validation", () => {
    const crossRun = validateMutation((source) =>
      source.replace(
        "          name: pr-review-advisor\n          path: publish-artifacts/pr-review-advisor",
        "          name: pr-review-advisor\n          path: publish-artifacts/pr-review-advisor\n          run-id: ${{ github.event.workflow_run.id }}",
      ),
    );
    expect(crossRun).toContain("Download primary advisor artifact must not set with.run-id");

    const noVersionCheck = validateMutation((source) =>
      source.replace("if (result.version !== 1)", "if (false)"),
    );
    expect(noVersionCheck).toContain(
      "step 'Validate primary advisor artifact' run script must include result.version !== 1",
    );
  });

  it("keeps publication best-effort while preserving the primary analysis failure", () => {
    const errors = validateMutation((source) =>
      source
        .replace(
          "    continue-on-error: ${{ !matrix.advisor.publish_comment }}",
          "    continue-on-error: true",
        )
        .replace(
          "    continue-on-error: true\n    permissions:\n      contents: read\n      pull-requests: write",
          "    continue-on-error: false\n    permissions:\n      contents: read\n      pull-requests: write",
        ),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "review job failures must be non-blocking only for non-publishing advisor lanes",
        "publish job must be best-effort so it cannot mask the primary analysis outcome",
      ]),
    );
  });

  it("keeps advisor matrix artifacts isolated", () => {
    const errors = validateMutation((source) =>
      source
        .replace(
          "artifact_dir: pr-review-advisor-nemotron-ultra",
          "artifact_dir: pr-review-advisor",
        )
        .replace(
          "artifact_name: pr-review-advisor-nemotron-ultra",
          "artifact_name: pr-review-advisor",
        )
        .replace("model: nvidia/nvidia/nemotron-3-ultra", "model: azure/openai/gpt-5.6-terra"),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "advisor matrix field model must be unique: azure/openai/gpt-5.6-terra",
        "advisor matrix field artifact_dir must be unique: pr-review-advisor",
        "advisor matrix field artifact_name must be unique: pr-review-advisor",
      ]),
    );
  });

  it("reports workflow parse failures through boundary errors", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-missing-"));
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
