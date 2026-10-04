// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "../../helpers/e2e-workflow-contract";

type PullRequestWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

const workflow = readYaml<PullRequestWorkflow>(".github/workflows/pr.yaml");

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step!;
}

describe("pull request docs-only merge base", () => {
  it("keeps hooks scoped to docs when main advances after the branch base (#8160)", () => {
    const job = workflow.jobs["docs-only-checks"];
    const resolveBase = requiredStep(job, "Resolve checked-out merge base for docs-only checks");
    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-docs-only-merge-base-"));
    const githubEnv = join(temp, "github-env");
    const git = (...args: string[]): string => {
      const result = spawnSync("git", args, { cwd: temp, encoding: "utf8" });
      expect(result.status, `git ${args.join(" ")} failed: ${result.stderr}`).toBe(0);
      return String(result.stdout).trim();
    };

    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "NemoClaw CI");
      git("config", "user.email", "nemoclaw-ci@example.invalid");
      writeFileSync(join(temp, "README.md"), "base\n");
      git("add", "README.md");
      git("commit", "-m", "test: create recorded base");
      const recordedBase = git("rev-parse", "HEAD");

      git("switch", "-c", "docs-change");
      mkdirSync(join(temp, "docs"));
      writeFileSync(join(temp, "docs", "guide.mdx"), "updated docs\n");
      git("add", "docs/guide.mdx");
      git("commit", "-m", "docs: update guide");
      const docsHead = git("rev-parse", "HEAD");

      git("switch", "main");
      mkdirSync(join(temp, "src"));
      writeFileSync(join(temp, "src", "runtime.ts"), "export const current = true;\n");
      git("add", "src/runtime.ts");
      git("commit", "-m", "fix: advance main");
      const liveBase = git("rev-parse", "HEAD");

      git("merge", "--no-ff", docsHead, "-m", "merge: create pull request revision");
      git("update-ref", "refs/remotes/origin/main", liveBase);

      const result = spawnSync("bash", ["-c", resolveBase.run ?? ""], {
        cwd: temp,
        encoding: "utf8",
        env: { ...process.env, GITHUB_BASE_REF: "main", GITHUB_ENV: githubEnv },
      });
      expect(result.status, result.stderr).toBe(0);

      const resolvedBase = readFileSync(githubEnv, "utf8").match(
        /^DOCS_ONLY_FROM_REF=([0-9a-f]{40})$/mu,
      )?.[1];
      expect(resolvedBase).toBe(liveBase);
      expect(resolvedBase).not.toBe(recordedBase);
      expect(git("diff", "--name-only", `${recordedBase}...HEAD`).split("\n")).toEqual([
        "docs/guide.mdx",
        "src/runtime.ts",
      ]);
      expect(git("diff", "--name-only", `${resolvedBase}...HEAD`)).toBe("docs/guide.mdx");
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  it("fails closed when the base branch cannot be resolved (#8160)", () => {
    const job = workflow.jobs["docs-only-checks"];
    const resolveBase = requiredStep(job, "Resolve checked-out merge base for docs-only checks");
    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-docs-only-missing-base-"));
    const githubEnv = join(temp, "github-env");
    const git = (...args: string[]): void => {
      const result = spawnSync("git", args, { cwd: temp, encoding: "utf8" });
      expect(result.status, `git ${args.join(" ")} failed: ${result.stderr}`).toBe(0);
    };

    try {
      git("init", "--initial-branch=docs-change");
      git("config", "user.name", "NemoClaw CI");
      git("config", "user.email", "nemoclaw-ci@example.invalid");
      writeFileSync(join(temp, "README.md"), "docs change\n");
      git("add", "README.md");
      git("commit", "-m", "docs: create pull request revision");

      const result = spawnSync("bash", ["-c", resolveBase.run ?? ""], {
        cwd: temp,
        encoding: "utf8",
        env: { ...process.env, GITHUB_BASE_REF: "missing", GITHUB_ENV: githubEnv },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBeNull();
      expect(result.status).not.toBe(0);
      expect(existsSync(githubEnv)).toBe(false);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });
});
