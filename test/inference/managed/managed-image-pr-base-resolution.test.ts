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

it("builds the current Deep Agents base when the registry alias was overwritten by an older run", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stale-pr-base-"));
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
  const publishedSha = runGit("rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(temporaryRoot, "Dockerfile.base"),
    "FROM scratch\nCOPY validator.py /validator.py\n",
  );
  fs.writeFileSync(path.join(temporaryRoot, "validator.py"), "print('ok')\n");
  runGit("add", "Dockerfile.base", "validator.py");
  runGit("commit", "--quiet", "-m", "test: update base");
  const baseSha = runGit("rev-parse", "HEAD");
  fs.writeFileSync(path.join(temporaryRoot, "candidate.txt"), "candidate\n");
  runGit("add", "candidate.txt");
  runGit("commit", "--quiet", "-m", "test: add candidate");
  const candidateSha = runGit("rev-parse", "HEAD");
  const exactManifest = '{"schemaVersion":2}\n';
  const digest = createHash("sha256").update(exactManifest).digest("hex");
  fs.writeFileSync(
    path.join(fakeBin, "docker"),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "\${1:-} \${2:-} \${3:-}" = "buildx imagetools inspect" ]; then
  if [[ "\${4:-}" == *:latest ]]; then
    printf '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"digest":"sha256:${digest}","platform":{"os":"linux","architecture":"amd64"}}]}\\n'
  else
    printf '%s\\n' '{"schemaVersion":2}'
  fi
  exit 0
fi
if [ "\${1:-}" = "pull" ]; then
  exit 0
fi
if [ "\${1:-} \${2:-}" = "image inspect" ]; then
  revision='${publishedSha}'
  if [[ "\${3:-}" == nemoclaw-managed-pr/* ]]; then
    revision='${candidateSha}'
  fi
  printf '[{"Config":{"Labels":{"org.opencontainers.image.revision":"%s"}},"Id":"sha256:%064d","Os":"linux","Architecture":"amd64"}]\\n' "$revision" 0
  exit 0
fi
if [ "\${1:-}" = "run" ]; then
  printf 'glibc 2.41\\n'
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
  : > "$docker_archive"
  oci_root="$RUNNER_TEMP/fake-oci"
  oci_digest="sha256:0000000000000000000000000000000000000000000000000000000000000000"
  mkdir -p "$oci_root"
  printf '{"manifests":[{"digest":"%s"}]}\\n' "$oci_digest" > "$oci_root/index.json"
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
    AGENT: "langchain-deepagents-code",
    BASE_ALIAS: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest",
    BASE_DOCKERFILE: "Dockerfile.base",
    BASE_REPOSITORY: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
    BASE_SHA: baseSha,
    CANDIDATE_SHA: candidateSha,
    DISPLAY_NAME: "Deep Agents Code",
    DOCKER_LOG: dockerLog,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    LOCAL_BASE_REFERENCE: "nemoclaw-managed-pr/langchain-deepagents-code-base:test",
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
    expect(result.stdout).toContain(
      "DCode registry base does not match the PR base commit; building the exact PR base locally",
    );
    expect(fs.readFileSync(output, "utf8")).toContain(
      "ref=nemoclaw-managed-pr/langchain-deepagents-code-base:test\nlocal=true\n",
    );
    expect(fs.readFileSync(dockerLog, "utf8")).toContain("buildx build");
    expect(fs.readFileSync(summary, "utf8")).toContain(
      `Locally built from \`Dockerfile.base\` at \`${candidateSha}\`.`,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
