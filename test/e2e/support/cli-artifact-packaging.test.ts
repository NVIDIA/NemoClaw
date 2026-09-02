// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CLI_ARTIFACT_PACKAGE_SCRIPT } from "../../../tools/e2e/cli-artifact-workflow-boundary.mts";

const REQUIRED_ARCHIVE_FILES = [
  "dist/nemoclaw.js",
  "dist/build-identity.json",
  "dist/lib/blueprint-runner.js",
  "dist/nemoclaw/package.json",
  "dist/nemoclaw/blueprint/runner.js",
  "nemoclaw/dist/shared/openshell-gateway-health-sdk.js",
  "nemoclaw/dist/shared/openshell-observation-boundary.cjs",
  "nemoclaw/dist/shared/openshell-policy-boundary.cjs",
  "nemoclaw/dist/shared/sandbox-name.cjs",
  "nemoclaw/dist/shared/snapshot-sanitizer-boundary.cjs",
] as const;

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function expectNonemptyRegularFile(file: string): void {
  const metadata = fs.lstatSync(file);
  expect(metadata.isFile(), file).toBe(true);
  expect(metadata.isSymbolicLink(), file).toBe(false);
  expect(metadata.size, file).toBeGreaterThan(0);
}

function runCliArtifactPackaging(mutateOutputs: (workspace: string) => void = () => undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-package-"));
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  const toolDirectory = path.join(root, "tools");
  fs.mkdirSync(workspace);
  fs.mkdirSync(runnerTemp);
  fs.mkdirSync(toolDirectory);
  const systemTar = execFileSync("which", ["tar"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(toolDirectory, "tar"),
    `#!/usr/bin/env bash
set -euo pipefail
args=()
for argument in "$@"; do
  case "$argument" in
    --sort=name|--mtime=@0|--owner=0|--group=0|--numeric-owner) ;;
    *) args+=("$argument") ;;
  esac
done
exec ${JSON.stringify(systemTar)} "\${args[@]}"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(workspace, "package-lock.json"), '{"lockfileVersion":3}\n');
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  execFileSync("git", ["add", "package-lock.json"], { cwd: workspace });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=NemoClaw Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: workspace },
  );
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();

  const dist = path.join(workspace, "dist");
  const packagedRunner = path.join(dist, "nemoclaw");
  const shared = path.join(workspace, "nemoclaw", "dist", "shared");
  fs.mkdirSync(path.join(dist, "lib"), { recursive: true });
  fs.mkdirSync(path.join(packagedRunner, "blueprint"), { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(dist, "nemoclaw.js"), 'console.log("fixture");\n');
  fs.writeFileSync(path.join(dist, "lib", "blueprint-runner.js"), 'console.log("fixture");\n');
  fs.writeFileSync(path.join(packagedRunner, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(packagedRunner, "blueprint", "runner.js"),
    'console.log("fixture");\n',
  );
  fs.writeFileSync(
    path.join(dist, "build-identity.json"),
    `${JSON.stringify({ nemoclawVersion: "0.0.0", sourceRevision: candidateSha })}\n`,
  );
  fs.writeFileSync(path.join(shared, "openshell-gateway-health-sdk.js"), "module.exports = {};\n");
  fs.writeFileSync(
    path.join(shared, "openshell-observation-boundary.cjs"),
    "module.exports = {};\n",
  );
  fs.writeFileSync(path.join(shared, "openshell-policy-boundary.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(shared, "sandbox-name.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(shared, "snapshot-sanitizer-boundary.cjs"), "module.exports = {};\n");
  mutateOutputs(workspace);

  const artifactDirectory = path.join(runnerTemp, "nemoclaw-cli-artifact");
  const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
  const workflowSha = "d".repeat(40);

  const result = spawnSync("bash", [path.resolve(CLI_ARTIFACT_PACKAGE_SCRIPT)], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      CANDIDATE_REPOSITORY: "NVIDIA/NemoClaw",
      CANDIDATE_SHA: candidateSha,
      GITHUB_OUTPUT: path.join(root, "github-output"),
      PATH: `${toolDirectory}:${process.env.PATH ?? ""}`,
      RUN_ATTEMPT: "1",
      RUN_ID: "12345",
      RUNNER_ARCH: "X64",
      RUNNER_OS: "Linux",
      RUNNER_TEMP: runnerTemp,
      WORKFLOW_SHA: workflowSha,
    },
  });
  return {
    artifactDirectory,
    artifactExists: fs.existsSync(artifactDirectory),
    candidateSha,
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
    lockfileSha256: sha256(path.join(workspace, "package-lock.json")),
    output: `${result.stdout}${result.stderr}`,
    result,
    sourceTree,
    systemTar,
    workflowSha,
  };
}

describe("CLI artifact packaging", () => {
  it("packages the candidate CLI", () => {
    const fixture = runCliArtifactPackaging();
    try {
      expect(fixture.result.status, fixture.output).toBe(0);
      expect(fixture.artifactExists).toBe(true);
      const manifestPath = path.join(fixture.artifactDirectory, "manifest.json");
      const payloadPath = path.join(fixture.artifactDirectory, "nemoclaw-cli.tar");
      expectNonemptyRegularFile(manifestPath);
      expectNonemptyRegularFile(payloadPath);

      const payloadSha256 = sha256(payloadPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest).toMatchObject({
        artifactName: `nemoclaw-cli-${fixture.candidateSha}-${payloadSha256}`,
        build: {
          command: "npm run build:cli",
          sourceRevision: fixture.candidateSha,
        },
        candidate: {
          lockfileSha256: fixture.lockfileSha256,
          repository: "NVIDIA/NemoClaw",
          sha: fixture.candidateSha,
          sourceTree: fixture.sourceTree,
        },
        kind: "nemoclaw-e2e-cli-artifact-v1",
        payload: { file: "nemoclaw-cli.tar", sha256: payloadSha256 },
        workflow: { runAttempt: "1", runId: "12345", sha: fixture.workflowSha },
      });

      const archiveListing = execFileSync(fixture.systemTar, ["-tvf", payloadPath], {
        encoding: "utf8",
      }).split("\n");
      const regularArchiveFiles = archiveListing
        .filter((entry) => entry.startsWith("-"))
        .map((entry) => entry.slice(entry.lastIndexOf(" ") + 1));
      expect(regularArchiveFiles).toEqual(expect.arrayContaining([...REQUIRED_ARCHIVE_FILES]));
    } finally {
      fixture.cleanup();
    }
  });

  it("fails before publication when a required build output is missing", () => {
    const missingOutput = "dist/nemoclaw.js";
    const fixture = runCliArtifactPackaging((workspace) => {
      fs.rmSync(path.join(workspace, missingOutput));
    });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.output).toContain(
        `candidate CLI build output is missing or is not a nonempty regular file: ${missingOutput}`,
      );
      expect(fixture.artifactExists).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
