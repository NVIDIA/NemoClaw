// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readYaml, type WorkflowJob, type WorkflowStep } from "../../helpers/e2e-workflow-contract";
import { describe, expect, it } from "vitest";

function runWorkflowShellStep(
  step: WorkflowStep,
  env: Record<string, string>,
  cwd = process.cwd(),
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-c", step.run ?? ""], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...step.env, ...env },
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

const reviewedSdk = {
  artifactName: "reviewed-sdk.tgz",
  integrity: "sha512-reviewed",
  packageSpec: "@nvidia/openshell-sdk@1.0.0",
};
const reviewedBundle = `reviewed-openshell-sdk-${createHash("sha256")
  .update(`${JSON.stringify([reviewedSdk])}\n`)
  .digest("hex")}`;
const mainSdkArtifact = {
  id: 100,
  name: reviewedBundle,
  expired: false,
  workflow_run: { id: 200, head_branch: "main", head_repository_id: 123 },
};
const mainSdkRun = {
  path: ".github/workflows/main.yaml",
  head_branch: "main",
  event: "push",
  head_repository: { full_name: "NVIDIA/NemoClaw" },
  repository: { full_name: "NVIDIA/NemoClaw" },
};

type SdkPackageLocatorFixture = Readonly<{
  artifacts?: readonly unknown[];
  inspectorOutput?: string;
  inspectorRequired?: unknown;
  run?: unknown;
  runs?: Readonly<Record<string, unknown>>;
  step: WorkflowStep;
  apiFailure?: boolean;
  headRepository?: string;
}>;

function runSdkPackageLocator(fixture: SdkPackageLocatorFixture): Readonly<{
  githubOutput: string;
  requests: string;
  sleeps: string;
  result: ReturnType<typeof runWorkflowShellStep>;
}> {
  const tempRoot = mkdtempSync(join(tmpdir(), "nemoclaw-sdk-package-locator-"));
  try {
    const trustedRoot = join(tempRoot, ".trusted-sdk-package-decision");
    const inspectorDirectory = join(trustedRoot, "scripts/checks");
    const fakeBin = join(tempRoot, "bin");
    mkdirSync(inspectorDirectory, { recursive: true });
    mkdirSync(join(trustedRoot, "ci"));
    mkdirSync(fakeBin);
    writeFileSync(
      join(trustedRoot, "ci/reviewed-npm-audit.json"),
      JSON.stringify({ sourceRegistryPackage: reviewedSdk }),
    );
    writeFileSync(
      join(inspectorDirectory, "prepare-ci-npm-install.mts"),
      `process.stdout.write(${JSON.stringify(fixture.inspectorOutput ?? JSON.stringify({ artifactName: "reviewed-sdk.tgz", required: fixture.inspectorRequired ?? true }))});\n`,
    );
    writeFileSync(
      join(fakeBin, "gh"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const request = process.argv.slice(2).join(" ");',
        'fs.appendFileSync(process.env.REQUEST_LOG, request + "\\n");',
        'if (process.env.API_FAILURE === "true") { process.stderr.write("private diagnostic"); process.exit(1); }',
        'if (request.includes("actions/artifacts?name=")) { process.stdout.write(process.env.ARTIFACTS); }',
        'else if (request.includes("actions/runs/")) { const id = request.match(/actions\\/runs\\/(\\d+)/)?.[1]; const run = JSON.parse(process.env.SDK_RUNS)[id]; if (!run) process.exit(64); process.stdout.write(JSON.stringify(run)); }',
        "else process.exit(64);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const sleepLog = join(tempRoot, "sleeps");
    writeFileSync(sleepLog, "");
    writeFileSync(join(fakeBin, "sleep"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SLEEP_LOG"\n', {
      mode: 0o755,
    });
    const outputPath = join(tempRoot, "github-output");
    const requestLog = join(tempRoot, "requests");
    writeFileSync(requestLog, "");
    const result = runWorkflowShellStep(
      fixture.step,
      {
        ARTIFACTS: JSON.stringify([{ artifacts: fixture.artifacts ?? [mainSdkArtifact] }]),
        API_FAILURE: String(fixture.apiFailure ?? false),
        SDK_RUNS: JSON.stringify(fixture.runs ?? { "200": fixture.run ?? mainSdkRun }),
        REQUEST_LOG: requestLog,
        SLEEP_LOG: sleepLog,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        GITHUB_WORKSPACE: tempRoot,
        REPOSITORY_ID: "123",
        HEAD_REPOSITORY: fixture.headRepository ?? "NVIDIA/NemoClaw",
        CANDIDATE_SHA: "a".repeat(40),
        UPGRADE_BASE_SHA: "b".repeat(40),
        UPGRADE_PR_NUMBER: "123",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      tempRoot,
    );
    return {
      githubOutput: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
      requests: readFileSync(requestLog, "utf8"),
      sleeps: readFileSync(sleepLog, "utf8"),
      result,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
describe("reviewed SDK artifact selection", () => {
  const workflow = readYaml<{ jobs: Record<string, WorkflowJob> }>(".github/workflows/pr.yaml");
  const locateSdk = workflow.jobs["openshell-sdk-package"].steps!.find(
    (step) => step.name === "Locate approved SDK artifact",
  )!;

  it("reuses a main SDK artifact without a package run for the PR commit", () => {
    const { result, githubOutput, requests } = runSdkPackageLocator({ step: locateSdk });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(githubOutput).toContain("artifact_id=100");
    expect(githubOutput).toContain("run_id=200");
    expect(requests).toContain(
      `--paginate --slurp repos/NVIDIA/NemoClaw/actions/artifacts?name=${reviewedBundle}`,
    );
    expect(requests.trim().split("\n")).toHaveLength(2);
  });

  it.each([
    { status: "completed", conclusion: "failure", includeOlder: true, selected: 100, sleeps: 0 },
    { status: "in_progress", conclusion: null, includeOlder: true, selected: 100, sleeps: 0 },
    { status: "completed", conclusion: "success", includeOlder: true, selected: 101, sleeps: 0 },
    { status: "completed", conclusion: "failure", includeOlder: false, selected: null, sleeps: 23 },
    { status: "in_progress", conclusion: null, includeOlder: false, selected: null, sleeps: 23 },
    { status: "unknown", conclusion: null, includeOlder: true, selected: null, sleeps: 0 },
    { status: "completed", conclusion: "unknown", includeOlder: true, selected: null, sleeps: 0 },
  ])(
    "requires a successful candidate SDK producer for %j",
    ({ status, conclusion, includeOlder, selected, sleeps }) => {
      const candidateSha = "a".repeat(40);
      const baseSha = "b".repeat(40);
      const bundleName = `candidate-openshell-sdk-123-${candidateSha}-${baseSha}-99`;
      const artifact = { ...mainSdkArtifact, name: bundleName };
      const run = {
        ...mainSdkRun,
        path: ".github/workflows/candidate-upgrade-admission.yaml",
        status: "completed",
        conclusion: "success",
        event: "pull_request_target",
        head_sha: candidateSha,
        pull_requests: [{ number: 123, head: { sha: candidateSha }, base: { sha: baseSha } }],
      };
      const {
        result,
        githubOutput,
        sleeps: observedSleeps,
      } = runSdkPackageLocator({
        step: locateSdk,
        inspectorOutput: JSON.stringify({
          required: true,
          artifactName: "reviewed-sdk.tgz",
          candidate: true,
          bundleName,
        }),
        artifacts: [
          ...(includeOlder ? [artifact] : []),
          { ...artifact, id: 101, workflow_run: { ...artifact.workflow_run, id: 201 } },
        ],
        runs: { "200": run, "201": { ...run, status, conclusion } },
      });
      expect(result.status, result.stdout + result.stderr).toBe(selected === null ? 1 : 0);
      expect(githubOutput).toBe(
        selected === null
          ? "required=true\n"
          : `required=true\nartifact_id=${selected}\nrun_id=${selected + 100}\nartifact_name=reviewed-sdk.tgz\n`,
      );
      expect(observedSleeps).toBe("5\n".repeat(sleeps));
    },
  );

  it("rejects a successful candidate producer with invalid provenance before using its archive", () => {
    const candidateSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const bundleName = `candidate-openshell-sdk-123-${candidateSha}-${baseSha}-99`;
    const { result, githubOutput } = runSdkPackageLocator({
      step: locateSdk,
      inspectorOutput: JSON.stringify({
        required: true,
        artifactName: "reviewed-sdk.tgz",
        candidate: true,
        bundleName,
      }),
      artifacts: [{ ...mainSdkArtifact, name: bundleName }],
      run: { ...mainSdkRun, status: "completed", conclusion: "success", head_sha: candidateSha },
    });
    expect(result.status).not.toBe(0);
    expect(githubOutput).not.toContain("artifact_id=");
  });

  it("skips SDK artifact lookup when the trusted inspector does not require a package", () => {
    const { result, githubOutput, requests } = runSdkPackageLocator({
      step: locateSdk,
      inspectorRequired: false,
    });
    expect(result.status).toBe(0);
    expect(githubOutput).toBe("required=false\n");
    expect(requests).toBe("");
  });

  it.each(["true", 1, {}, null])(
    "rejects malformed package decision %j before artifact lookup",
    (required) => {
      const { result, requests } = runSdkPackageLocator({
        step: locateSdk,
        inspectorOutput: JSON.stringify({ required }),
      });
      expect(result.status).not.toBe(0);
      expect(requests).toBe("");
    },
  );

  it("rejects fork access before SDK artifact lookup", () => {
    const { result, requests } = runSdkPackageLocator({
      step: locateSdk,
      headRepository: "example/fork",
    });
    expect(result.status).not.toBe(0);
    expect(requests).toBe("");
  });

  it.each([
    { ...mainSdkArtifact, expired: true },
    { ...mainSdkArtifact, name: "another-package" },
    {
      ...mainSdkArtifact,
      workflow_run: { ...mainSdkArtifact.workflow_run, head_branch: "feature" },
    },
    {
      ...mainSdkArtifact,
      workflow_run: { ...mainSdkArtifact.workflow_run, head_repository_id: 456 },
    },
  ])("rejects unavailable or untrusted SDK artifact %j", (artifact) => {
    const { result, requests } = runSdkPackageLocator({ step: locateSdk, artifacts: [artifact] });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("gh workflow run main.yaml --ref main");
    expect(requests.trim().split("\n")).toHaveLength(1);
  });

  it.each([
    { ...mainSdkRun, path: ".github/workflows/pr.yaml" },
    { ...mainSdkRun, event: "pull_request_target" },
    { ...mainSdkRun, head_branch: "feature" },
    { ...mainSdkRun, head_repository: { full_name: "example/fork" } },
  ])("rejects untrusted SDK producer %j", (run) => {
    const { result, githubOutput } = runSdkPackageLocator({ step: locateSdk, run });
    expect(result.status).not.toBe(0);
    expect(githubOutput).not.toContain("artifact_id=");
  });

  it("reports artifact lookup failures without private API diagnostics", () => {
    const { result } = runSdkPackageLocator({ step: locateSdk, apiFailure: true });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Restore Actions access");
    expect(result.stdout).not.toContain("private diagnostic");
    expect(result.stderr).not.toContain("private diagnostic");
  });
});
