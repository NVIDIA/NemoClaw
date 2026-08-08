// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "./helpers/e2e-workflow-contract";

type QualificationWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

const CANDIDATE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const REPOSITORY = "NVIDIA/NemoClaw";

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert(step, `Missing workflow step: ${name}`);
  return step;
}

function requiredRunStep(job: WorkflowJob, name: string): string {
  const run = requiredStep(job, name).run;
  assert(run, `Workflow step does not define a shell program: ${name}`);
  return run;
}

const workflow = readYaml<QualificationWorkflow>(
  ".github/workflows/openshell-0.0.101-qualification.yaml",
);
const receiptJob = workflow.jobs.receipt;
const authenticateScript = requiredRunStep(receiptJob, "Authenticate exact qualification dispatch");
const produceScript = requiredRunStep(
  receiptJob,
  "Produce receipt from authenticated source checks",
);
const consumeScript = requiredRunStep(receiptJob, "Consume and validate the produced receipt");

const rejectionCases: ReadonlyArray<{
  name: string;
  overrides: Record<string, string>;
}> = [
  { name: "non-maintainer actor", overrides: { FAKE_ROLE: "write" } },
  { name: "stale candidate", overrides: { FAKE_CANDIDATE_SHA: "c".repeat(40) } },
  { name: "replayed workflow revision", overrides: { EXPECTED_WORKFLOW_SHA: "c".repeat(40) } },
  { name: "invalid run attempt", overrides: { RUN_ATTEMPT: "0" } },
];

function withTempDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-qualification-workflow-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function installFakeCurl(directory: string): string {
  const bin = path.join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const curl = path.join(bin, "curl");
  const dollar = "$";
  writeFileSync(
    curl,
    String.raw`#!/usr/bin/env bash
set -euo pipefail
url="${dollar}{@: -1}"
case "$url" in
  */collaborators/*/permission)
    printf '{"role_name":"%s"}\n' "${dollar}{FAKE_ROLE:-maintain}"
    ;;
  */pulls/*)
    printf '{"number":%s,"state":"open","head":{"sha":"%s","repo":{"full_name":"%s"}},"base":{"sha":"%s","ref":"main","repo":{"full_name":"%s"}}}\n' \
      "$FAKE_PR_NUMBER" "$FAKE_CANDIDATE_SHA" "$GITHUB_REPOSITORY" "$FAKE_BASE_SHA" "$GITHUB_REPOSITORY"
    ;;
  */git/ref/heads/main)
    printf '{"object":{"sha":"%s"}}\n' "$FAKE_MAIN_SHA"
    ;;
  */commits/*)
    printf '{"parents":[{"sha":"%s"}]}\n' "$FAKE_PARENT_SHA"
    ;;
  *)
    printf 'unexpected URL: %s\n' "$url" >&2
    exit 1
    ;;
esac
`,
    "utf8",
  );
  chmodSync(curl, 0o700);
  return bin;
}

function runAuthentication(directory: string, overrides: Record<string, string> = {}) {
  const bin = installFakeCurl(directory);
  const executionContext = overrides.EXECUTION_CONTEXT ?? "selector";
  const workflowSha = executionContext === "release" ? CANDIDATE_SHA : BASE_SHA;
  return spawnSync("bash", ["--noprofile", "--norc", "-c", authenticateScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      ACTOR: "maintainer",
      BASE_SHA,
      CANDIDATE_SHA,
      EXECUTION_CONTEXT: executionContext,
      EXPECTED_WORKFLOW_SHA: workflowSha,
      FAKE_BASE_SHA: BASE_SHA,
      FAKE_CANDIDATE_SHA: CANDIDATE_SHA,
      FAKE_MAIN_SHA: CANDIDATE_SHA,
      FAKE_PARENT_SHA: BASE_SHA,
      FAKE_PR_NUMBER: "8600",
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_TOKEN: "test-token",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PHASE: executionContext === "selector" ? "selector" : "final",
      PR_NUMBER: executionContext === "release" ? "" : "8600",
      RUN_ATTEMPT: "1",
      TRIGGERING_ACTOR: "maintainer",
      WORKFLOW_SHA: workflowSha,
      ...overrides,
    },
  });
}

function installFakeNode(directory: string): string {
  const bin = path.join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const node = path.join(bin, "node");
  const dollar = "$";
  writeFileSync(
    node,
    String.raw`#!/usr/bin/env bash
set -euo pipefail
: "${dollar}{NODE_LOG:?}"
printf '%s\n' "$@" > "$NODE_LOG"
`,
    "utf8",
  );
  chmodSync(node, 0o700);
  return bin;
}

function runContractStep(
  directory: string,
  script: string,
  executionContext: "release" | "selector",
) {
  const bin = installFakeNode(directory);
  const log = path.join(directory, "node-arguments.txt");
  const trustedRoot = path.join(directory, "trusted");
  const candidateRoot = path.join(directory, "candidate");
  const receiptDirectory = path.join(directory, "receipt");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      BASE_SHA,
      CANDIDATE_ROOT: candidateRoot,
      CANDIDATE_SHA,
      EXECUTION_CONTEXT: executionContext,
      GITHUB_TOKEN: "test-token",
      NODE_LOG: log,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PHASE: executionContext === "release" ? "final" : "selector",
      PR_NUMBER: executionContext === "release" ? "" : "8600",
      RECEIPT_DIR: receiptDirectory,
      REPOSITORY,
      RUN_ATTEMPT: "1",
      RUN_ID: "12345",
      RUN_URL: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345/attempts/1",
      TRUSTED_ROOT: trustedRoot,
      WORKFLOW_SHA: executionContext === "release" ? CANDIDATE_SHA : BASE_SHA,
    },
  });
  const argumentsPassed =
    result.status === 0 ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
  return { argumentsPassed, candidateRoot, receiptDirectory, result, trustedRoot };
}

describe("OpenShell 0.0.101 qualification receipt producer workflow", () => {
  it.each([
    "selector",
    "final-promotion",
    "release",
  ] as const)("authenticates an exact %s dispatch from maintainers (#8600)", (executionContext) =>
    withTempDirectory((directory) => {
      const result = runAuthentication(directory, { EXECUTION_CONTEXT: executionContext });
      expect(result.status, result.stderr).toBe(0);
    }));

  it.each(rejectionCases)("rejects a $name before producing evidence (#8600)", ({ overrides }) =>
    withTempDirectory((directory) => {
      const result = runAuthentication(directory, overrides);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("::error::");
    }));

  it("passes exact selector identity into producer and consumer execution (#8600)", () =>
    withTempDirectory((directory) => {
      const produced = runContractStep(directory, produceScript, "selector");
      expect(produced.result.status, produced.result.stderr).toBe(0);
      expect(produced.argumentsPassed).toEqual([
        "--experimental-strip-types",
        "--no-warnings",
        path.join(produced.trustedRoot, "scripts/checks/openshell-qualification-contract.mts"),
        "produce",
        "--contract-root",
        produced.trustedRoot,
        "--candidate-root",
        produced.candidateRoot,
        "--execution-context",
        "selector",
        "--phase",
        "selector",
        "--repository",
        REPOSITORY,
        "--candidate-sha",
        CANDIDATE_SHA,
        "--base-sha",
        BASE_SHA,
        "--trusted-workflow-sha",
        BASE_SHA,
        "--trusted-workflow-run-id",
        "12345",
        "--trusted-workflow-run-attempt",
        "1",
        "--trusted-workflow-run-url",
        "https://github.com/NVIDIA/NemoClaw/actions/runs/12345/attempts/1",
        "--output",
        path.join(produced.receiptDirectory, "qualification.json"),
        "--pr-number",
        "8600",
      ]);

      const consumed = runContractStep(directory, consumeScript, "selector");
      expect(consumed.result.status, consumed.result.stderr).toBe(0);
      expect(consumed.argumentsPassed).toEqual([
        "--experimental-strip-types",
        "--no-warnings",
        path.join(consumed.trustedRoot, "scripts/checks/openshell-qualification-contract.mts"),
        "validate",
        "--contract-root",
        consumed.trustedRoot,
        "--candidate-root",
        consumed.candidateRoot,
        "--execution-context",
        "selector",
        "--receipt",
        path.join(consumed.receiptDirectory, "qualification.json"),
        "--phase",
        "selector",
        "--repository",
        REPOSITORY,
        "--candidate-sha",
        CANDIDATE_SHA,
        "--base-sha",
        BASE_SHA,
        "--pr-number",
        "8600",
      ]);
    }));

  it("omits pull-request identity only in release producer execution (#8600)", () =>
    withTempDirectory((directory) => {
      const produced = runContractStep(directory, produceScript, "release");
      expect(produced.result.status, produced.result.stderr).toBe(0);
      expect(produced.argumentsPassed).toContain("release");
      expect(produced.argumentsPassed).toContain("final");
      expect(produced.argumentsPassed).not.toContain("--pr-number");
    }));
});
