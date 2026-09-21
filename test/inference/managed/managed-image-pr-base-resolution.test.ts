// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const resolver = path.join(repoRoot, "scripts/checks/resolve-managed-pr-base.sh");

it("builds a changed PR base locally and fails closed on comparison errors", () => {
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
    const result = spawnSync(resolver, [], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: environment,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe(
      `ref=nemoclaw-managed-pr/openclaw-base:test\nlocal=true\noci=${temporaryRoot}/pr-base.oci@sha256:0000000000000000000000000000000000000000000000000000000000000000\n`,
    );
    const dockerCommands = fs.readFileSync(dockerLog, "utf8");
    expect(dockerCommands).toContain("buildx build");
    expect(dockerCommands).toContain(`load --input ${temporaryRoot}/pr-base.docker.tar`);
    expect(dockerCommands).not.toContain("imagetools inspect");
    expect(fs.readFileSync(summary, "utf8")).toContain(
      `Locally built from \`Dockerfile.base\` at \`${candidateSha}\`.`,
    );

    const invalidRevision = spawnSync(resolver, [], {
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

it.each([
  {
    compatible: true,
    expectedLocal: false,
    title: "reuses a published DCode base that satisfies the current runtime contract",
  },
  {
    compatible: false,
    expectedLocal: true,
    title:
      "builds the DCode base locally when the published base fails the current runtime contract",
  },
])("$title", ({ compatible, expectedLocal }) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-pr-base-"));
  const fakeBin = path.join(temporaryRoot, "bin");
  const output = path.join(temporaryRoot, "output");
  const summary = path.join(temporaryRoot, "summary");
  const dockerLog = path.join(temporaryRoot, "docker.log");
  const nodeLog = path.join(temporaryRoot, "node.log");
  const exactRaw = '{"schemaVersion":2,"config":{"digest":"sha256:base"}}';
  const digest = `sha256:${createHash("sha256").update(exactRaw).digest("hex")}`;
  const aliasRaw = JSON.stringify({
    manifests: [{ digest, platform: { architecture: "amd64", os: "linux" } }],
    mediaType: "application/vnd.oci.image.index.v1+json",
  });
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
  const candidateSha = runGit("rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(fakeBin, "node"),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NODE_LOG"
[ "$DCODE_RUNTIME_COMPATIBLE" = true ]
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "docker"),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "\${1:-} \${2:-} \${3:-}" = "buildx imagetools inspect" ]; then
  if [ "\${4:-}" = "$BASE_ALIAS" ]; then
    printf '%s' "$ALIAS_RAW"
  else
    printf '%s' "$EXACT_RAW"
  fi
  exit 0
fi
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
  printf '{"manifests":[{"digest":"%s"}]}\\n' "$oci_digest" > "$oci_root/index.json"
  tar -C "$oci_root" -cf "$oci_archive" index.json
  exit 0
fi
if [ "\${1:-} \${2:-}" = "load --input" ] || [ "\${1:-}" = pull ]; then
  exit 0
fi
if [ "\${1:-} \${2:-}" = "image inspect" ]; then
  printf '[{"Config":{"Labels":{"org.opencontainers.image.revision":"%s"}},"Id":"sha256:%s","Os":"linux","Architecture":"amd64"}]\\n' \
    "$CANDIDATE_SHA" "$(printf 'b%.0s' {1..64})"
  exit 0
fi
if [ "\${1:-}" = run ]; then
  printf 'glibc 2.41\\n'
  exit 0
fi
exit 90
`,
    { mode: 0o755 },
  );
  const environment = {
    ...process.env,
    AGENT: "langchain-deepagents-code",
    ALIAS_RAW: aliasRaw,
    BASE_ALIAS: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest",
    BASE_DOCKERFILE: "Dockerfile.base",
    BASE_REPOSITORY: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
    BASE_SHA: candidateSha,
    CANDIDATE_SHA: candidateSha,
    DCODE_RUNTIME_COMPATIBLE: compatible ? "true" : "false",
    DISPLAY_NAME: "Deep Agents Code",
    DOCKER_LOG: dockerLog,
    EXACT_RAW: exactRaw,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    LOCAL_BASE_REFERENCE: "nemoclaw-managed-pr/langchain-deepagents-code-base:test",
    NODE_LOG: nodeLog,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    PLATFORM: "linux/amd64",
    RUNNER_TEMP: temporaryRoot,
  };

  try {
    const result = spawnSync(resolver, [], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: environment,
    });
    expect(result.status, result.stderr).toBe(0);
    const resolverOutput = fs.readFileSync(output, "utf8");
    expect(resolverOutput).toContain(`local=${String(expectedLocal)}\n`);
    const dockerCommands = fs.readFileSync(dockerLog, "utf8");
    expect(dockerCommands.includes("buildx build")).toBe(expectedLocal);
    expect(fs.readFileSync(nodeLog, "utf8")).toContain(
      `--reference ${environment.BASE_REPOSITORY}@${digest} --platform linux/amd64`,
    );
    expect(
      fs
        .readFileSync(summary, "utf8")
        .includes("Reason: published base does not satisfy the current runtime contract."),
    ).toBe(expectedLocal);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
