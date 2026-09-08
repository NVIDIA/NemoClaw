// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import type { WorkflowJob, WorkflowStep } from "../../helpers/e2e-workflow-contract";

type Workflow = {
  jobs: Record<string, WorkflowJob & { name?: string; permissions?: Record<string, string> }>;
};

function workflow(path: string): Workflow {
  return YAML.parse(readFileSync(path, "utf8")) as Workflow;
}

function step(job: WorkflowJob, name: string): WorkflowStep {
  const selected = job.steps?.find((candidate) => candidate.name === name);
  expect(selected).toBeDefined();
  return selected as WorkflowStep;
}

const pr = workflow(".github/workflows/pr.yaml");
const commitLint = workflow(".github/workflows/commit-lint.yaml");
const dco = workflow(".github/workflows/dco-check.yaml");
const installerHash = workflow(".github/workflows/installer-hash-check.yaml");
const codeScanning = workflow(".github/workflows/code-scanning.yaml");
const advisor = workflow(".github/workflows/pr-review-advisor.yaml");
const standardGuard = step(
  commitLint.jobs["commit-lint"],
  "Bind validation to the live generated head",
);
const dcoGuard = step(dco.jobs["dco-check"], "Bind validation to the live generated head");
const installerHashGuard = step(
  installerHash.jobs["check-hash"],
  "Bind validation to the live generated head",
);
const codeScanningGuard = step(
  codeScanning.jobs["validate-repair-target"],
  "Bind validation to the live generated head",
);
const prGuard = step(pr.jobs.changes, "Bind validation to the live generated head");
const advisorGuard = step(
  advisor.jobs["discover-specialists"],
  "Bind validation to the live generated head",
);

function runGuard(guard: WorkflowStep, overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-repair-head-guard-"));
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      'const endpoint = process.argv.at(-1) ?? "";',
      'if (endpoint.includes("/pulls/")) {',
      "  process.stdout.write(JSON.stringify({",
      '    state: "open", draft: false,',
      '    head: { sha: process.env.FAKE_HEAD_SHA, repo: { full_name: "NVIDIA/NemoClaw" } },',
      '    base: { sha: process.env.FAKE_BASE_SHA, ref: "main", repo: { full_name: "NVIDIA/NemoClaw" } },',
      "  }));",
      "  process.exit(0);",
      "}",
      'if (endpoint.includes("/commits/")) {',
      "  process.stdout.write(JSON.stringify({ parents: JSON.parse(process.env.FAKE_PARENTS) }));",
      "  process.exit(0);",
      "}",
      "process.exit(64);",
    ].join("\n"),
    { mode: 0o755 },
  );
  const head = "1".repeat(40);
  const sourceHead = "2".repeat(40);
  const base = "3".repeat(40);
  const result = spawnSync("bash", ["-c", guard.run ?? ""], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      ...guard.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      RUNNER_TEMP: root,
      GH_TOKEN: "test-token",
      PR_NUMBER: "10791",
      HEAD_SHA: head,
      SOURCE_HEAD_SHA: sourceHead,
      BASE_SHA: base,
      REPAIR_ATTEMPT_KEY: `sha256:${"4".repeat(64)}`,
      FINDING_IDS: "[]",
      PUBLISH_REQUESTED: "false",
      FAKE_HEAD_SHA: head,
      FAKE_BASE_SHA: base,
      FAKE_PARENTS: JSON.stringify([{ sha: sourceHead }]),
      ...overrides,
    },
  });
  rmSync(root, { recursive: true, force: true });
  return result.status;
}

describe("generated-head repair workflow guards", () => {
  it.each([
    ["commit lint", standardGuard],
    ["DCO", dcoGuard],
    ["installer hash", installerHashGuard],
    ["code scanning", codeScanningGuard],
    ["pull request", prGuard],
    ["advisor", advisorGuard],
  ])("accepts a valid %s exact-head dispatch", (_name, guard) => {
    expect(runGuard(guard)).toBe(0);
  });

  it.each([
    ["commit lint", standardGuard],
    ["DCO", dcoGuard],
    ["installer hash", installerHashGuard],
    ["code scanning", codeScanningGuard],
    ["pull request", prGuard],
    ["advisor", advisorGuard],
  ])("rejects a stale head in the %s guard", (_name, guard) => {
    expect(runGuard(guard, { FAKE_HEAD_SHA: "5".repeat(40) })).not.toBe(0);
  });

  it.each([
    ["commit lint", standardGuard],
    ["DCO", dcoGuard],
    ["installer hash", installerHashGuard],
    ["code scanning", codeScanningGuard],
    ["pull request", prGuard],
    ["advisor", advisorGuard],
  ])("rejects a changed base in the %s guard", (_name, guard) => {
    expect(runGuard(guard, { FAKE_BASE_SHA: "6".repeat(40) })).not.toBe(0);
  });

  // source-shape-contract: security -- Executing the shipped parent guard proves generated merge or replacement commits fail before checkout.
  it.each([
    ["wrong", JSON.stringify([{ sha: "7".repeat(40) }])],
    ["additional", JSON.stringify([{ sha: "2".repeat(40) }, { sha: "3".repeat(40) }])],
  ])("rejects a %s generated-head parent set", (_name, parents) => {
    expect(runGuard(prGuard, { FAKE_PARENTS: parents })).toBeTruthy();
  });

  it.each([
    [pr.jobs["repair-receipt"], "repair_pr_number"],
    [commitLint.jobs["repair-receipt"], "repair_pr_number"],
    [dco.jobs["repair-receipt"], "repair_pr_number"],
    [installerHash.jobs["repair-receipt"], "repair_pr_number"],
    [codeScanning.jobs["repair-receipt"], "repair_pr_number"],
    [advisor.jobs["repair-validation-receipt"], "target_pr"],
  ])("binds a trusted receipt job to all exact repair inputs", (receipt, prInput) => {
    expect(receipt.name).toContain("Repair receipt {0} PR {1} head {2} base {3}");
    expect(receipt.permissions).toEqual({});
    expect(JSON.stringify(receipt)).toContain("repair_attempt_key");
    expect(JSON.stringify(receipt)).toContain(prInput);
    expect(JSON.stringify(receipt)).toContain("repair_head_sha");
    expect(JSON.stringify(receipt)).toContain("repair_base_sha");
  });
});
