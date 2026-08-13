// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");

function resolverScript(): string {
  const workflow = YAML.parse(
    fs.readFileSync(path.join(repoRoot, ".github/workflows/managed-images.yaml"), "utf8"),
  ) as {
    jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const resolver = workflow.jobs?.["pr-build-and-entrypoint"]?.steps?.find(
    ({ name }) => name === "Resolve exact linux/amd64 PR base",
  )?.run;
  return (
    resolver ??
    (() => {
      throw new Error("PR base resolver script is missing");
    })()
  );
}

it("builds a changed PR base locally and fails closed on comparison errors", () => {
  const resolver = resolverScript();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-pr-base-"));
  const fakeBin = path.join(temporaryRoot, "bin");
  const output = path.join(temporaryRoot, "output");
  const summary = path.join(temporaryRoot, "summary");
  const dockerLog = path.join(temporaryRoot, "docker.log");
  fs.mkdirSync(fakeBin);
  const runGit = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: temporaryRoot, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  runGit("init", "--quiet");
  runGit("config", "user.name", "NemoClaw Test");
  runGit("config", "user.email", "nemoclaw-test@example.invalid");
  fs.writeFileSync(path.join(temporaryRoot, "Dockerfile.base"), "FROM scratch\n");
  runGit("add", "Dockerfile.base");
  runGit("commit", "--quiet", "-m", "test: add base");
  const baseSha = runGit("rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(temporaryRoot, "Dockerfile.base"),
    "FROM scratch\nLABEL test=changed\n",
  );
  runGit("add", "Dockerfile.base");
  runGit("commit", "--quiet", "-m", "test: change base");
  const candidateSha = runGit("rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(fakeBin, "docker"),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "\${1:-} \${2:-}" = "buildx build" ]; then
  exit 0
fi
exit 90
`,
    { mode: 0o755 },
  );
  const environment = {
    ...process.env,
    BASE_ALIAS: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
    BASE_DOCKERFILE: "Dockerfile.base",
    BASE_REPOSITORY: "ghcr.io/nvidia/nemoclaw/sandbox-base",
    BASE_SHA: baseSha,
    CANDIDATE_SHA: candidateSha,
    DISPLAY_NAME: "OpenClaw",
    DOCKER_LOG: dockerLog,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    LOCAL_BASE_REFERENCE: "nemoclaw-managed-pr/openclaw-base:test",
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    RUNNER_TEMP: temporaryRoot,
  };

  try {
    const result = spawnSync("bash", ["-c", resolver], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: environment,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe("ref=nemoclaw-managed-pr/openclaw-base:test\n");
    expect(fs.readFileSync(dockerLog, "utf8")).toContain(
      "buildx build --platform linux/amd64 --load --file Dockerfile.base --tag nemoclaw-managed-pr/openclaw-base:test .",
    );
    expect(fs.readFileSync(dockerLog, "utf8")).not.toContain("imagetools inspect");

    const invalidRevision = spawnSync("bash", ["-c", resolver], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: { ...environment, CANDIDATE_SHA: "f".repeat(40) },
    });
    expect(invalidRevision.status).not.toBe(0);
    expect(invalidRevision.stderr).toContain("PR base Dockerfile comparison failed");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
