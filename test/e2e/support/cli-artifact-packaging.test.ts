// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CLI_ARTIFACT_PACKAGE_SCRIPT } from "../../../tools/e2e/cli-artifact-workflow-boundary.mts";

function runCliArtifactPackaging() {
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
  fs.writeFileSync(
    path.join(shared, "openshell-gateway-health-sdk.js"),
    "module.exports = {};\n",
  );
  fs.writeFileSync(
    path.join(shared, "openshell-observation-boundary.cjs"),
    "module.exports = {};\n",
  );
  fs.writeFileSync(
    path.join(shared, "openshell-policy-boundary.cjs"),
    "module.exports = {};\n",
  );
  fs.writeFileSync(path.join(shared, "sandbox-name.cjs"), "module.exports = {};\n");
  fs.writeFileSync(
    path.join(shared, "snapshot-sanitizer-boundary.cjs"),
    "module.exports = {};\n",
  );

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
      WORKFLOW_SHA: "d".repeat(40),
    },
  });
  return {
    artifactExists: fs.existsSync(path.join(runnerTemp, "nemoclaw-cli-artifact")),
    artifactPayload: path.join(runnerTemp, "nemoclaw-cli-artifact", "nemoclaw-cli.tar"),
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
    output: `${result.stdout}${result.stderr}`,
    result,
  };
}

describe("CLI artifact packaging", () => {
  it("packages the candidate CLI", () => {
    const fixture = runCliArtifactPackaging();
    try {
      expect(fixture.result.status, fixture.output).toBe(0);
      expect(fixture.artifactExists).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
