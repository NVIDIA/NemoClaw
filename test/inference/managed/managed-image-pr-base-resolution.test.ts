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
    candidateContents: "unrelated candidate change\n",
    candidatePath: "README.md",
    expectedLocal: false,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "reuses a published DCode base built from the same runtime contract inputs",
  },
  {
    candidateContents: "print('new contract')\n",
    candidatePath: "agents/langchain-deepagents-code/validate-runtime-contract.py",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "builds the DCode base locally when its published source predates the runtime contract",
  },
  {
    candidateContents: "security patch v2\n",
    candidatePath: "scripts/security/patches/libssh2-1.11.1-cve-2026.patch",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "builds the DCode base locally when a copied security input changed",
  },
  {
    candidateContents:
      'import fs from "node:fs";\nfs.writeFileSync(process.env.PARSER_SIDE_EFFECT, "executed");\nexport const fixture = false;\n',
    candidatePath: "scripts/lib/dockerfile-copy-sources.mts",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "builds the DCode base locally when its COPY parser changed",
  },
  {
    candidateContents: "adversarial contract v2\n",
    candidatePath: ":security-contract",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "treats a leading-colon COPY source as a literal Git path",
  },
  {
    candidateContents: "unrelated candidate change\n",
    candidatePath: "README.md",
    expectedLocal: true,
    failPublishedPull: true,
    rejectCopyParsing: false,
    title: "builds the DCode base locally when the published base cannot be verified",
  },
  {
    candidateContents: "candidate documentation\n",
    candidatePath: "README.md",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: true,
    title: "builds the DCode base locally when direct COPY parsing rejects the Dockerfile",
  },
])("$title", (testCase) => {
  const { candidateContents, candidatePath, expectedLocal, failPublishedPull, rejectCopyParsing } =
    testCase;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-pr-base-"));
  const fakeBin = path.join(temporaryRoot, "bin");
  const output = path.join(temporaryRoot, "output");
  const parserSideEffect = path.join(temporaryRoot, "parser-side-effect");
  const summary = path.join(temporaryRoot, "summary");
  const dockerLog = path.join(temporaryRoot, "docker.log");
  const exactRaw = '{"schemaVersion":2,"config":{"digest":"sha256:base"}}';
  const digest = `sha256:${createHash("sha256").update(exactRaw).digest("hex")}`;
  const baseRepository = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
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
  const agentRoot = path.join(temporaryRoot, "agents/langchain-deepagents-code");
  const adversarialInput = ":security-contract";
  const copyParser = "scripts/lib/dockerfile-copy-sources.mts";
  const fixtureResolver = path.join(temporaryRoot, "scripts/checks/resolve-managed-pr-base.sh");
  const securityPatch = "scripts/security/patches/libssh2-1.11.1-cve-2026.patch";
  const unsupportedCopy = rejectCopyParsing ? 'COPY ["README.md", "/tmp/README.md"]\n' : "";
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.mkdirSync(path.dirname(fixtureResolver), { recursive: true });
  fs.mkdirSync(path.join(temporaryRoot, path.dirname(copyParser)), { recursive: true });
  fs.mkdirSync(path.join(temporaryRoot, path.dirname(securityPatch)), { recursive: true });
  fs.writeFileSync(
    path.join(agentRoot, "Dockerfile.base"),
    `FROM scratch\nCOPY --chmod=0444 ${securityPatch} /tmp/libssh2.patch\nCOPY agents/langchain-deepagents-code/requirements.lock /tmp/requirements.lock\nCOPY agents/langchain-deepagents-code/validate-runtime-contract.py /tmp/validate-runtime-contract.py\nCOPY ${adversarialInput} /tmp/security-contract\n${unsupportedCopy}`,
  );
  fs.writeFileSync(path.join(agentRoot, "requirements.lock"), "deepagents==0.7.5\n");
  fs.writeFileSync(path.join(agentRoot, "validate-runtime-contract.py"), "print('ok')\n");
  fs.writeFileSync(path.join(temporaryRoot, adversarialInput), "adversarial contract v1\n");
  fs.copyFileSync(resolver, fixtureResolver);
  fs.chmodSync(fixtureResolver, 0o755);
  fs.copyFileSync(path.join(repoRoot, copyParser), path.join(temporaryRoot, copyParser));
  fs.writeFileSync(path.join(temporaryRoot, securityPatch), "security patch v1\n");
  fs.writeFileSync(path.join(temporaryRoot, ".dockerignore"), ".git\n");
  runGit(
    "add",
    "--",
    ".dockerignore",
    "agents/langchain-deepagents-code",
    `:(literal)${adversarialInput}`,
    copyParser,
    securityPatch,
  );
  runGit("commit", "--quiet", "-m", "test: add base");
  const publishedSourceSha = runGit("rev-parse", "HEAD");
  fs.mkdirSync(path.dirname(path.join(temporaryRoot, candidatePath)), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, candidatePath), candidateContents);
  runGit("add", "--", candidatePath.startsWith(":") ? `:(literal)${candidatePath}` : candidatePath);
  runGit("commit", "--quiet", "-m", "test: create candidate");
  const candidateSha = runGit("rev-parse", "HEAD");
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
if [ "\${1:-} \${2:-}" = "load --input" ]; then
  exit 0
fi
if [ "\${1:-}" = pull ]; then
  [ "$FAIL_PUBLISHED_PULL" = false ] || exit 89
  exit 0
fi
if [ "\${1:-} \${2:-}" = "image inspect" ]; then
  source_revision="$PUBLISHED_SOURCE_SHA"
  if [ "\${3:-}" = "$LOCAL_BASE_REFERENCE" ]; then
    source_revision="$CANDIDATE_SHA"
  fi
  printf '[{"Config":{"Labels":{"org.opencontainers.image.revision":"%s"}},"Id":"sha256:%s","Os":"linux","Architecture":"amd64"}]\\n' \
    "$source_revision" "$(printf 'b%.0s' {1..64})"
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
    BASE_ALIAS: `${baseRepository}:latest`,
    BASE_DOCKERFILE: "agents/langchain-deepagents-code/Dockerfile.base",
    BASE_REPOSITORY: baseRepository,
    BASE_SHA: candidateSha,
    CANDIDATE_SHA: candidateSha,
    DISPLAY_NAME: "Deep Agents Code",
    DOCKER_LOG: dockerLog,
    EXACT_RAW: exactRaw,
    FAIL_PUBLISHED_PULL: String(failPublishedPull),
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    LOCAL_BASE_REFERENCE: "nemoclaw-managed-pr/langchain-deepagents-code-base:test",
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    PARSER_SIDE_EFFECT: parserSideEffect,
    PLATFORM: "linux/amd64",
    PUBLISHED_SOURCE_SHA: publishedSourceSha,
    RUNNER_TEMP: temporaryRoot,
  };

  try {
    const result = spawnSync(fixtureResolver, [], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: environment,
    });
    expect(result.status, result.stderr).toBe(0);
    const resolverOutput = fs.readFileSync(output, "utf8");
    expect(resolverOutput).toContain(`local=${String(expectedLocal)}\n`);
    const dockerCommands = fs.readFileSync(dockerLog, "utf8");
    expect(dockerCommands.includes("buildx build")).toBe(expectedLocal);
    expect(dockerCommands).not.toContain("validate-dcode-runtime-contract.py");
    expect(fs.existsSync(parserSideEffect)).toBe(false);
    const summaryContents = fs.readFileSync(summary, "utf8");
    expect(summaryContents.includes("Reason: published base ")).toBe(expectedLocal);
    expect(summaryContents.includes(candidateSha)).toBe(expectedLocal);
    expect(summaryContents.includes(`Reason: published base ${baseRepository}@${digest}`)).toBe(
      expectedLocal,
    );
    const expectedSourceRevision = expectedLocal && !failPublishedPull;
    expect(summaryContents.includes(publishedSourceSha)).toBe(expectedSourceRevision);
    const expectedChangedInput = expectedSourceRevision && !rejectCopyParsing;
    expect(summaryContents.includes(candidatePath)).toBe(expectedChangedInput);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
