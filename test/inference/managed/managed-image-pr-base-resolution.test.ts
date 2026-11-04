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

it.each(["amd64", "arm64"])(
  "pins one %s PR base descriptor and rejects torn index evidence",
  (architecture) => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-base-"));
    const fakeBin = path.join(temporaryRoot, "bin");
    const aliasRaw = path.join(temporaryRoot, "alias.raw");
    const exactRaw = path.join(temporaryRoot, "exact.raw");
    const output = path.join(temporaryRoot, "output");
    const summary = path.join(temporaryRoot, "summary");
    fs.mkdirSync(fakeBin);
    const exactBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: `sha256:${"a".repeat(64)}`, size: 1 },
      layers: [],
    });
    const digest = `sha256:${createHash("sha256").update(exactBody).digest("hex")}`;
    const descriptor = {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest,
      size: exactBody.length,
      platform: { os: "linux", architecture },
    };
    const writeAlias = (manifests: unknown[]) => {
      fs.writeFileSync(
        aliasRaw,
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests,
        }),
      );
    };
    const otherPlatform = {
      ...descriptor,
      digest: `sha256:${"f".repeat(64)}`,
      platform: {
        os: "linux",
        architecture: architecture === "amd64" ? "arm64" : "amd64",
      },
    };
    writeAlias([otherPlatform, descriptor]);
    fs.writeFileSync(exactRaw, exactBody);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/bin/bash
set -euo pipefail
if [ "\${1:-} \${2:-} \${3:-}" = "buildx imagetools inspect" ]; then
if [[ "\${4:-}" == *":latest" ]]; then
  cat "$ALIAS_RAW"
else
  cat "$EXACT_RAW"
fi
elif [ "$*" = "pull --platform $PLATFORM $EXACT_REFERENCE" ]; then
exit 0
elif [ "$*" = "image inspect $EXACT_REFERENCE" ]; then
printf '[{"Config":{"Labels":{"org.opencontainers.image.revision":"%s"}}}]' "$CANDIDATE_SHA"
else
exit 90
fi
`,
      { mode: 0o755 },
    );
    const runResolver = () =>
      spawnSync(resolver, [], {
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT: "openclaw",
          ALIAS_RAW: aliasRaw,
          BASE_ALIAS: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
          BASE_DOCKERFILE: "Dockerfile.base",
          BASE_REPOSITORY: "ghcr.io/nvidia/nemoclaw/sandbox-base",
          BASE_SHA: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
          CANDIDATE_SHA: spawnSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).stdout.trim(),
          DISPLAY_NAME: "OpenClaw",
          EXACT_RAW: exactRaw,
          EXACT_REFERENCE: `ghcr.io/nvidia/nemoclaw/sandbox-base@${digest}`,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          LOCAL_BASE_REFERENCE: "nemoclaw-managed-pr/openclaw-base:test",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PLATFORM: `linux/${architecture}`,
          RUNNER_TEMP: temporaryRoot,
        },
      });

    try {
      const accepted = runResolver();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toContain(
        `ref=ghcr.io/nvidia/nemoclaw/sandbox-base@${digest}`,
      );

      writeAlias([descriptor, descriptor]);
      const duplicate = runResolver();
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.stderr).toContain(
        `does not contain exactly one linux/${architecture} image`,
      );

      writeAlias([otherPlatform]);
      const missing = runResolver();
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain(`does not contain exactly one linux/${architecture} image`);

      writeAlias([descriptor]);
      fs.appendFileSync(exactRaw, " ");
      const wrongBody = runResolver();
      expect(wrongBody.status).not.toBe(0);
      expect(wrongBody.stderr).toContain(
        "exact PR base bytes do not match the selected descriptor digest",
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

it.each(["amd64", "arm64"])(
  "builds a changed %s PR base locally and rejects comparison errors",
  (architecture) => {
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
      PLATFORM: `linux/${architecture}`,
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
      expect(dockerCommands).toContain(`buildx build --platform linux/${architecture}`);
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
  },
);

it.each([undefined, "", "linux/s390x", "windows/amd64"])(
  "rejects unsupported platform %s before inspecting or building a base",
  (platform) => {
    const result = spawnSync(resolver, [], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, PLATFORM: platform },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("supported Linux platform");
    expect(result.stdout).toBe("");
  },
);

it("rejects an unsupported PR base resolution mode before reading a base", () => {
  const result = spawnSync(resolver, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      PLATFORM: "linux/amd64",
      RESOLUTION_MODE: "trust-candidate-provenance",
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("resolution mode is invalid");
});

const publishedBaseCases = [
  {
    candidateContents: "export const version = 2;\n",
    candidatePath: "scripts/security/inventory.mts",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "builds locally when a mounted security input changed",
  },
  {
    candidateContents: "unrelated candidate change\n",
    candidatePath: "README.md",
    expectedLocal: false,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "reuses a published base built from the same inputs",
  },
  {
    candidateContents: "print('new contract')\n",
    candidatePath: "agents/langchain-deepagents-code/validate-runtime-contract.py",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "builds locally when the published source predates a copied runtime contract",
  },
  {
    candidateContents: "security patch v2\n",
    candidatePath: "scripts/security/patches/libssh2-1.11.1-cve-2026.patch",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "builds locally when a copied security input changed",
  },
  {
    candidateContents: "deepagents==0.8.0\n",
    candidatePath: "agents/langchain-deepagents-code/requirements.lock",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "builds locally when a copied dependency lock changed without a Dockerfile edit",
  },
  {
    candidateContents: ".git\nREADME.md\n",
    candidatePath: ".dockerignore",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "builds locally when the Docker context exclusions changed",
  },
  {
    candidateContents:
      'import fs from "node:fs";\nfs.writeFileSync(process.env.PARSER_SIDE_EFFECT, "executed");\nexport const fixture = false;\n',
    candidatePath: "scripts/lib/dockerfile-copy-sources.mts",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: false,
    title: "builds locally without executing a changed COPY parser",
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
    title: "builds locally when the published base cannot be verified",
  },
  {
    candidateContents: "candidate documentation\n",
    candidatePath: "README.md",
    expectedLocal: true,
    failPublishedPull: false,
    rejectCopyParsing: true,
    title: "builds locally when direct COPY parsing rejects the Dockerfile",
  },
] as const;

type BaseCase = (typeof publishedBaseCases)[number] & { agent: string; architecture: string };

function assertBaseResolution(
  testCase: BaseCase,
  resolutionMode: "build-local" | "reference-or-candidate",
): void {
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
    manifests: [{ digest, platform: { architecture: testCase.architecture, os: "linux" } }],
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
  const mountedInventory = "scripts/security/inventory.mts";
  const unsupportedCopy = rejectCopyParsing ? 'COPY ["README.md", "/tmp/README.md"]\n' : "";
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.mkdirSync(path.dirname(fixtureResolver), { recursive: true });
  fs.mkdirSync(path.join(temporaryRoot, path.dirname(copyParser)), { recursive: true });
  fs.mkdirSync(path.join(temporaryRoot, path.dirname(securityPatch)), { recursive: true });
  fs.writeFileSync(
    path.join(agentRoot, "Dockerfile.base"),
    `FROM scratch\nCOPY --chmod=0444 ${securityPatch} /tmp/libssh2.patch\nCOPY agents/langchain-deepagents-code/requirements.lock /tmp/requirements.lock\nCOPY agents/langchain-deepagents-code/validate-runtime-contract.py /tmp/validate-runtime-contract.py\nCOPY ${adversarialInput} /tmp/security-contract\nRUN --mount=type=bind,source=${mountedInventory},target=/inventory.mts node /inventory.mts\n${unsupportedCopy}`,
  );
  fs.writeFileSync(path.join(agentRoot, "requirements.lock"), "deepagents==0.7.5\n");
  fs.writeFileSync(path.join(agentRoot, "validate-runtime-contract.py"), "print('ok')\n");
  fs.writeFileSync(path.join(temporaryRoot, adversarialInput), "adversarial contract v1\n");
  fs.copyFileSync(resolver, fixtureResolver);
  fs.chmodSync(fixtureResolver, 0o755);
  fs.copyFileSync(path.join(repoRoot, copyParser), path.join(temporaryRoot, copyParser));
  fs.writeFileSync(path.join(temporaryRoot, securityPatch), "security patch v1\n");
  fs.writeFileSync(path.join(temporaryRoot, mountedInventory), "export const version = 1;\n");
  fs.writeFileSync(path.join(temporaryRoot, ".dockerignore"), ".git\n");
  runGit(
    "add",
    "--",
    ".dockerignore",
    "agents/langchain-deepagents-code",
    `:(literal)${adversarialInput}`,
    copyParser,
    securityPatch,
    mountedInventory,
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
  printf '[{"Config":{"Labels":{"org.opencontainers.image.revision":"%s"}},"Id":"sha256:%s","Os":"linux","Architecture":"%s"}]\\n' \
    "$source_revision" "$(printf 'b%.0s' {1..64})" "\${PLATFORM#linux/}"
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
    AGENT: testCase.agent,
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
    PLATFORM: `linux/${testCase.architecture}`,
    PUBLISHED_SOURCE_SHA: publishedSourceSha,
    RESOLUTION_MODE: resolutionMode,
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
    expect(resolverOutput).toContain(
      expectedLocal
        ? `local=${resolutionMode === "build-local" ? "true" : "deferred"}\n`
        : "local=false\n",
    );
    expect(resolverOutput).toContain(
      expectedLocal && resolutionMode === "reference-or-candidate"
        ? "ref=candidate\n"
        : `ref=${expectedLocal ? environment.LOCAL_BASE_REFERENCE : `${baseRepository}@${digest}`}\n`,
    );
    const dockerCommands = fs.readFileSync(dockerLog, "utf8");
    expect(dockerCommands.includes(`buildx build --platform ${environment.PLATFORM}`)).toBe(
      expectedLocal && resolutionMode === "build-local",
    );
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
}

it.each(
  // One synthetic COPY contract exercises every agent routed through this resolver.
  publishedBaseCases.flatMap((testCase) =>
    ["openclaw", "hermes", "langchain-deepagents-code"].flatMap((agent) =>
      ["amd64", "arm64"].map((architecture) => ({ ...testCase, agent, architecture })),
    ),
  ),
)("$agent ($architecture): $title", (testCase) => {
  assertBaseResolution(testCase, "build-local");
});

it.each(
  publishedBaseCases.flatMap((testCase) =>
    (["amd64", "arm64"] as const).map((architecture) => ({ ...testCase, architecture })),
  ),
)("protected OpenClaw ($architecture): $title", (testCase) => {
  assertBaseResolution({ ...testCase, agent: "openclaw" }, "reference-or-candidate");
});
