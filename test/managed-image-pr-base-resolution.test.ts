// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");

type WorkflowStep = { name?: string; run?: string; with?: Record<string, string> };

function workflowSteps(job: string): WorkflowStep[] {
  const workflow = YAML.parse(
    fs.readFileSync(path.join(repoRoot, ".github/workflows/managed-images.yaml"), "utf8"),
  ) as { jobs?: Record<string, { steps?: WorkflowStep[] }> };
  return workflow.jobs?.[job]?.steps ?? [];
}

function workflowStep(job: string, name: string): WorkflowStep {
  return (
    workflowSteps(job).find((step) => step.name === name) ??
    (() => {
      throw new Error(`${job} step is missing: ${name}`);
    })()
  );
}

function resolverScript(): string {
  const resolver = workflowStep("pr-build-and-entrypoint", "Resolve exact linux/amd64 PR base").run;
  return (
    resolver ??
    (() => {
      throw new Error("PR base resolver script is missing");
    })()
  );
}

it("keeps immutable DCode base metadata on exact PR and production images", () => {
  const prJob = "pr-build-and-entrypoint";
  const productionJob = "build-and-validate";
  const prResolver = resolverScript();
  const prLocalBuild = workflowStep(prJob, "Build PR managed image from local base");
  const prRegistryBuild = workflowStep(prJob, "Build PR managed image from registry base");
  const prPublish = workflowStep(prJob, "Publish exact same-repository PR managed image by digest");
  const prValidate = workflowStep(prJob, "Validate exact PR managed image contract");
  const productionBase = workflowStep(productionJob, "Validate exact base image contract");
  const productionBuild = workflowStep(productionJob, "Build and push managed image by digest");
  const productionValidate = workflowStep(
    productionJob,
    "Validate exact managed image before promotion",
  );

  expect(prResolver).toContain("sourceRevision:$revision");
  expect(prLocalBuild.run).toContain("com.nvidia.nemoclaw.base-resolution=${RESOLUTION_LABEL}");
  expect(prRegistryBuild.with?.labels).toContain("com.nvidia.nemoclaw.base-resolution={0}");
  expect(prPublish.with?.labels).toContain("com.nvidia.nemoclaw.base-resolution={0}");
  expect(productionBuild.with?.labels).toContain("com.nvidia.nemoclaw.base-resolution={0}");
  expect(productionBase.run).toContain("sourceRevision:$revision");
  expect(prValidate.run).toContain("managed image lost base resolution metadata");
  expect(productionValidate.run).toContain("image lost base resolution metadata");
});

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
  docker_archive=""
  oci_archive=""
  for argument in "$@"; do
    case "$argument" in
      type=docker,dest=*) docker_archive="\${argument#*dest=}" ;;
      type=oci,dest=*) oci_archive="\${argument#*dest=}" ;;
    esac
  done
  [ -n "$docker_archive" ] && [ -n "$oci_archive" ] || exit 91
  : > "$docker_archive"
  oci_root="$RUNNER_TEMP/fake-oci"
  oci_digest="sha256:0000000000000000000000000000000000000000000000000000000000000000"
  mkdir -p "$oci_root"
  printf '{"manifests":[{"digest":"%s"}]}\n' "$oci_digest" > "$oci_root/index.json"
  tar -C "$oci_root" -cf "$oci_archive" index.json
  exit 0
fi
if [ "\${1:-} \${2:-}" = "load --input" ]; then
  exit 0
fi
exit 90
`,
    { mode: 0o755 },
  );
  const environment = {
    ...process.env,
    AGENT: "openclaw",
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
    expect(fs.readFileSync(output, "utf8")).toBe(
      `ref=nemoclaw-managed-pr/openclaw-base:test\nlocal=true\noci=${temporaryRoot}/pr-base.oci@sha256:0000000000000000000000000000000000000000000000000000000000000000\n`,
    );
    const dockerCommands = fs.readFileSync(dockerLog, "utf8");
    expect(dockerCommands).toContain(
      `buildx build --platform linux/amd64 --provenance=false --sbom=false --file Dockerfile.base --tag nemoclaw-managed-pr/openclaw-base:test --output type=docker,dest=${temporaryRoot}/pr-base.docker.tar --output type=oci,dest=${temporaryRoot}/pr-base.oci.tar .`,
    );
    expect(dockerCommands).toContain(`load --input ${temporaryRoot}/pr-base.docker.tar`);
    expect(dockerCommands).not.toContain("imagetools inspect");

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
