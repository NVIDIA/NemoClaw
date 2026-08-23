// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts/checks/build-protected-managed-images.sh");
const REVISION = "a".repeat(40);
const DIGEST = "b".repeat(64);

let testRoot = "";
let stubBin = "";
let dockerLog = "";
let dockerBuildCount = "";
let dockerBuildFailureMode = "";
let seedLog = "";
let registryCurlExit = "";
let registryLog = "";
let registryStatus = "";
let teeFailureMode = "";

function writeExecutable(name: string, source: string): void {
  const target = path.join(stubBin, name);
  writeFileSync(target, source, "utf8");
  chmodSync(target, 0o755);
}

function stubBuildInvocation(): void {
  writeExecutable(
    "docker",
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$NEMOCLAW_TEST_DOCKER_LOG"
case "$*" in
  "buildx imagetools inspect "*) printf '{}\n' ;;
  "buildx build "*)
    build_count=0
    if [[ -f "$NEMOCLAW_TEST_DOCKER_BUILD_COUNT" ]]; then
      read -r build_count <"$NEMOCLAW_TEST_DOCKER_BUILD_COUNT"
    fi
    build_count=$((build_count + 1))
    printf '%s\n' "$build_count" >"$NEMOCLAW_TEST_DOCKER_BUILD_COUNT"
    case "$NEMOCLAW_TEST_DOCKER_BUILD_FAILURE_MODE:$build_count" in
      exact-once:1 | exact-always:1 | exact-always:2)
        printf '%s\n' 'ERROR: failed to build: failed to solve: stream error: stream ID 71; INTERNAL_ERROR; received from peer' >&2
        exit 42
        ;;
      near-match:1)
        printf '%s\n' 'ERROR: failed to build: failed to solve: stream error: stream ID 71; INTERNAL_ERROR; received from server' >&2
        exit 42
        ;;
      npm-registry-dns-once:1 | npm-registry-dns-always:1 | npm-registry-dns-always:2)
        printf '%s\n' '#128 0.180 ERROR: curl failed: curl: (6) Could not resolve host: registry.npmjs.org' >&2
        printf '%s\n' 'ERROR: failed to build: failed to solve: process "/bin/sh -c node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts --npm-root /usr/local/lib/node_modules/npm" did not complete successfully: exit code: 1' >&2
        exit 42
        ;;
      npm-registry-dns-near-match:1)
        printf '%s\n' '#128 0.180 ERROR: curl failed: curl: (6) Could not resolve host: registry.npmjs.com' >&2
        exit 42
        ;;
    esac
    ;;
  "pull "*) ;;
  "image inspect "*) printf '[]\n' ;;
  *) exit 91 ;;
esac
`,
  );
  writeExecutable(
    "jq",
    `#!/usr/bin/env bash
case "$*" in
  *containerimage.digest*) printf 'sha256:${DIGEST}\\n' ;;
  *"if length == 1 then .[0].Id"*) printf 'sha256:${DIGEST}\\n' ;;
  *"--arg agent "*) printf '{}\\n' ;;
  *"-se "*) printf '[]\\n' ;;
  *) ;;
esac
`,
  );
  writeExecutable("sha256sum", `#!/usr/bin/env bash\nprintf '%s  %s\\n' '${DIGEST}' "$1"\n`);
  writeExecutable(
    "node",
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$NEMOCLAW_TEST_SEED_LOG"
mode="$4"
shift 4
output=""
while (($# > 0)); do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    *) shift ;;
  esac
done
mkdir -p "$output"
case "$mode" in
  export)
    printf '{"kind":"test"}\n' >"$output/manifest.json"
    printf 'archive\n' >"$output/complete-1.0.0.tgz"
    ;;
  copy)
    printf 'archive\n' >"$output/complete-1.0.0.tgz"
    ;;
  *) exit 92 ;;
esac
`,
  );
  writeExecutable("sleep", "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    "tee",
    '#!/usr/bin/env bash\nPATH="$NEMOCLAW_TEST_REAL_PATH" command tee "$@"\nstatus="$?"\nif [[ "$NEMOCLAW_TEST_TEE_FAILURE_MODE" == "always" ]]; then exit 43; fi\nexit "$status"\n',
  );
  writeExecutable(
    "curl",
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >>"$NEMOCLAW_TEST_REGISTRY_LOG"\nprintf \'%s\' "$NEMOCLAW_TEST_REGISTRY_STATUS"\nexit "$NEMOCLAW_TEST_REGISTRY_CURL_EXIT"\n',
  );
}

function completeImportedAgentCaches(cacheRoot: string): void {
  for (const agent of ["openclaw", "hermes", "langchain-deepagents-code"]) {
    mkdirSync(path.join(cacheRoot, agent, "blobs", "sha256"), { recursive: true });
    writeFileSync(path.join(cacheRoot, agent, "index.json"), "{}\n", "utf8");
  }
}

function completeImportedCache(cacheRoot: string): void {
  completeImportedAgentCaches(cacheRoot);
  mkdirSync(path.join(cacheRoot, "npm-cache-seed"));
  writeFileSync(path.join(cacheRoot, "npm-cache-seed", "manifest.json"), "{}\n", "utf8");
  mkdirSync(path.join(cacheRoot, "mcp-runtime-npm-cache-seed"));
  writeFileSync(
    path.join(cacheRoot, "mcp-runtime-npm-cache-seed", "manifest.json"),
    "{}\n",
    "utf8",
  );
  mkdirSync(path.join(cacheRoot, "messaging-npm-cache-seed"));
  writeFileSync(path.join(cacheRoot, "messaging-npm-cache-seed", "manifest.json"), "{}\n", "utf8");
}

function completeSourceBoundary(sourceRoot: string): void {
  mkdirSync(path.join(sourceRoot, "nemoclaw"), { recursive: true });
  mkdirSync(path.join(sourceRoot, "scripts", "checks"), { recursive: true });
  mkdirSync(path.join(sourceRoot, "tools", "mcp-tool-discovery-runtime", "npm-cache-seed"), {
    recursive: true,
  });
  mkdirSync(
    path.join(sourceRoot, "tools", "mcp-tool-discovery-runtime", "mcp-runtime-npm-cache-seed"),
    { recursive: true },
  );
  mkdirSync(
    path.join(
      sourceRoot,
      "agents",
      "openclaw",
      "managed-image-messaging-runtime",
      "npm-cache-seed",
    ),
    { recursive: true },
  );
  writeFileSync(path.join(sourceRoot, "nemoclaw", "package-lock.json"), "{}\n", "utf8");
  writeFileSync(
    path.join(sourceRoot, "tools", "mcp-tool-discovery-runtime", "package-lock.json"),
    "{}\n",
    "utf8",
  );
  writeFileSync(
    path.join(
      sourceRoot,
      "agents",
      "openclaw",
      "managed-image-messaging-runtime",
      "package-lock.json",
    ),
    "{}\n",
    "utf8",
  );
  writeFileSync(
    path.join(sourceRoot, "scripts", "checks", "materialize-locked-npm-cache-seed.mts"),
    "export {};\n",
    "utf8",
  );
}

function recordedBuildInvocations(): string[] {
  return readFileSync(dockerLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("buildx build "));
}

function recordedBuildInvocation(agent: string): string {
  const invocation = recordedBuildInvocations().find((line) =>
    line.includes(`io.nvidia.nemoclaw.agent=${agent}`),
  );
  expect(invocation, `missing ${agent} build invocation`).toBeDefined();
  return invocation!;
}

function runBuild(
  sourceRoot: string,
  extraArgs: readonly string[] = [],
  platform = "linux/amd64",
) {
  const output = path.join(testRoot, "contracts.json");
  return spawnSync(
    "bash",
    [
      SCRIPT,
      "--output",
      output,
      "--revision",
      REVISION,
      "--cohort",
      "protected-1-1",
      "--platform",
      platform,
      "--openclaw-base",
      `ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:${DIGEST}`,
      "--hermes-base",
      `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${DIGEST}`,
      "--dcode-base",
      `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base@sha256:${DIGEST}`,
      "--source-root",
      sourceRoot,
      ...extraArgs,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_TEST_DOCKER_BUILD_COUNT: dockerBuildCount,
        NEMOCLAW_TEST_DOCKER_BUILD_FAILURE_MODE: dockerBuildFailureMode,
        NEMOCLAW_TEST_DOCKER_LOG: dockerLog,
        NEMOCLAW_TEST_REGISTRY_CURL_EXIT: registryCurlExit,
        NEMOCLAW_TEST_REGISTRY_LOG: registryLog,
        NEMOCLAW_TEST_REGISTRY_STATUS: registryStatus,
        NEMOCLAW_TEST_REAL_PATH: process.env.PATH ?? "",
        NEMOCLAW_TEST_SEED_LOG: seedLog,
        NEMOCLAW_TEST_TEE_FAILURE_MODE: teeFailureMode,
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: testRoot,
      },
    },
  );
}

beforeEach(() => {
  testRoot = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-protected-build-"));
  stubBin = path.join(testRoot, "bin");
  dockerLog = path.join(testRoot, "docker.log");
  dockerBuildCount = path.join(testRoot, "docker-build-count");
  dockerBuildFailureMode = "";
  seedLog = path.join(testRoot, "seed.log");
  registryCurlExit = "0";
  registryLog = path.join(testRoot, "registry.log");
  registryStatus = "404";
  teeFailureMode = "";
  mkdirSync(stubBin);
  writeExecutable(
    "docker",
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$NEMOCLAW_TEST_DOCKER_LOG"\nexit 88\n',
  );
  writeExecutable("jq", "#!/usr/bin/env bash\nexit 89\n");
  writeExecutable("sha256sum", "#!/usr/bin/env bash\nexit 90\n");
});

afterEach(() => {
  rmSync(testRoot, { force: true, recursive: true });
});

describe("protected managed-image source-root boundary", () => {
  it("accepts one absolute non-symlink source root before invoking Docker", () => {
    const sourceRoot = path.join(testRoot, "candidate");
    completeSourceBoundary(sourceRoot);

    const result = runBuild(sourceRoot);

    expect(result.status, result.stderr).toBe(88);
    expect(readFileSync(dockerLog, "utf8")).toContain("buildx imagetools inspect");
  });

  it.each([
    ["relative", () => "."],
    ["newline-bearing", () => `${testRoot}/candidate\n`],
    ["missing", () => path.join(testRoot, "missing")],
    [
      "symlink",
      () => {
        const target = path.join(testRoot, "candidate");
        const link = path.join(testRoot, "candidate-link");
        mkdirSync(target);
        symlinkSync(target, link, "dir");
        return link;
      },
    ],
  ])("rejects a %s source root before invoking Docker", (_case, sourceRoot) => {
    const result = runBuild(sourceRoot());

    expect(result.status, result.stderr).toBe(2);
    expect(existsSync(dockerLog)).toBe(false);
  });
});

describe("protected managed-image build-cache boundary", () => {
  it("passes the selected Buildx architecture explicitly to every Dockerfile", () => {
    stubBuildInvocation();

    const result = runBuild(REPO_ROOT, [], "linux/arm64");

    expect(result.status, result.stderr).toBe(0);
    expect(recordedBuildInvocation("openclaw")).toContain("--platform linux/arm64");
    expect(recordedBuildInvocation("openclaw")).toContain("--build-arg TARGETARCH=arm64");
    expect(recordedBuildInvocation("hermes")).toContain("--platform linux/arm64");
    expect(recordedBuildInvocation("hermes")).toContain("--build-arg TARGETARCH=arm64");
    expect(recordedBuildInvocation("langchain-deepagents-code")).toContain("--platform linux/arm64");
    expect(recordedBuildInvocation("langchain-deepagents-code")).toContain(
      "--build-arg TARGETARCH=arm64",
    );
  });

  it("builds every agent without optional cache arguments", () => {
    stubBuildInvocation();

    const result = runBuild(REPO_ROOT);

    expect(result.status, result.stderr).toBe(0);
    expect(recordedBuildInvocations()).toHaveLength(3);

    expect({
      openclaw: recordedBuildInvocation("openclaw"),
      hermes: recordedBuildInvocation("hermes"),
      "langchain-deepagents-code": recordedBuildInvocation("langchain-deepagents-code"),
    }).toEqual({
      openclaw: expect.not.stringMatching(/--cache-to|--cache-from|--network none/),
      hermes: expect.not.stringMatching(/--cache-to|--cache-from|--network none/),
      "langchain-deepagents-code": expect.not.stringMatching(
        /--cache-to|--cache-from|--network none/,
      ),
    });
  });

  it("binds every protected build to the selected target architecture", () => {
    stubBuildInvocation();

    const result = runBuild(REPO_ROOT, ["--platform", "linux/arm64"]);

    expect(result.status, result.stderr).toBe(0);
    expect(recordedBuildInvocations()).toHaveLength(3);
    expect(recordedBuildInvocation("openclaw")).toContain("--platform linux/arm64");
    expect(recordedBuildInvocation("openclaw")).toContain("--build-arg TARGETARCH=arm64");
    expect(recordedBuildInvocation("hermes")).toContain("--platform linux/arm64");
    expect(recordedBuildInvocation("hermes")).toContain("--build-arg TARGETARCH=arm64");
    expect(recordedBuildInvocation("langchain-deepagents-code")).toContain("--platform linux/arm64");
    expect(recordedBuildInvocation("langchain-deepagents-code")).toContain("--build-arg TARGETARCH=arm64");
  });

  it("passes each agent one empty absolute cache export root", () => {
    const cacheRoot = path.join(testRoot, "export-cache");
    stubBuildInvocation();

    const result = runBuild(REPO_ROOT, ["--cache-to", cacheRoot]);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(cacheRoot)).toBe(true);
    expect(recordedBuildInvocations()).toHaveLength(3);

    expect({
      openclaw: recordedBuildInvocation("openclaw"),
      hermes: recordedBuildInvocation("hermes"),
      "langchain-deepagents-code": recordedBuildInvocation("langchain-deepagents-code"),
    }).toEqual({
      openclaw: expect.stringContaining(
        `--cache-to type=local,dest=${realpathSync(cacheRoot)}/openclaw,mode=max`,
      ),
      hermes: expect.stringContaining(
        `--cache-to type=local,dest=${realpathSync(cacheRoot)}/hermes,mode=max`,
      ),
      "langchain-deepagents-code": expect.stringContaining(
        `--cache-to type=local,dest=${realpathSync(cacheRoot)}/langchain-deepagents-code,mode=max`,
      ),
    });

    expect(readFileSync(seedLog, "utf8")).toContain(
      `materialize-locked-npm-cache-seed.mts export --lockfile ${REPO_ROOT}/nemoclaw/package-lock.json --output ${realpathSync(cacheRoot)}/npm-cache-seed`,
    );
    expect(existsSync(path.join(cacheRoot, "npm-cache-seed", "manifest.json"))).toBe(true);
    expect(readFileSync(seedLog, "utf8")).toContain(
      `materialize-locked-npm-cache-seed.mts export --lockfile ${REPO_ROOT}/tools/mcp-tool-discovery-runtime/package-lock.json --output ${realpathSync(cacheRoot)}/mcp-runtime-npm-cache-seed`,
    );
    expect(existsSync(path.join(cacheRoot, "mcp-runtime-npm-cache-seed", "manifest.json"))).toBe(
      true,
    );
    expect(readFileSync(seedLog, "utf8")).toContain(
      `materialize-locked-npm-cache-seed.mts export --lockfile ${REPO_ROOT}/agents/openclaw/managed-image-messaging-runtime/package-lock.json --output ${realpathSync(cacheRoot)}/messaging-npm-cache-seed`,
    );
    expect(existsSync(path.join(cacheRoot, "messaging-npm-cache-seed", "manifest.json"))).toBe(
      true,
    );
  });

  it.each([
    ["relative", () => "export-cache"],
    [
      "symlink",
      () => {
        const target = path.join(testRoot, "cache-target");
        const link = path.join(testRoot, "cache-link");
        mkdirSync(target);
        symlinkSync(target, link, "dir");
        return link;
      },
    ],
  ])("rejects a %s cache export root before invoking Docker", (_case, cacheRoot) => {
    const result = runBuild(REPO_ROOT, ["--cache-to", cacheRoot()]);

    expect(result.status, result.stderr).toBe(2);
    expect(existsSync(dockerLog)).toBe(false);
  });

  it("rejects a populated cache export root before invoking Docker", () => {
    const cacheRoot = path.join(testRoot, "export-cache");
    mkdirSync(cacheRoot);
    writeFileSync(path.join(cacheRoot, "foreign-record"), "untrusted\n", "utf8");

    const result = runBuild(REPO_ROOT, ["--cache-to", cacheRoot]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("protected managed-image cache destination must be empty");
    expect(existsSync(dockerLog)).toBe(false);
  });

  it("rejects an incomplete imported cache before invoking Docker", () => {
    const cacheRoot = path.join(testRoot, "imported-cache");
    mkdirSync(cacheRoot);

    const result = runBuild(REPO_ROOT, ["--cache-from", cacheRoot]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("imported cache is incomplete for openclaw");
    expect(existsSync(dockerLog)).toBe(false);
  });

  it("rejects imported agent caches that omit the complete locked npm seed", () => {
    const cacheRoot = path.join(testRoot, "imported-cache");
    completeImportedAgentCaches(cacheRoot);

    const result = runBuild(REPO_ROOT, ["--cache-from", cacheRoot]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("imported cache has no locked npm cache seed");
    expect(existsSync(dockerLog)).toBe(false);
  });

  it("rejects an imported cache that omits the locked messaging npm seed", () => {
    const cacheRoot = path.join(testRoot, "imported-cache");
    completeImportedCache(cacheRoot);
    rmSync(path.join(cacheRoot, "messaging-npm-cache-seed"), { recursive: true });

    const result = runBuild(REPO_ROOT, ["--cache-from", cacheRoot]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("imported cache has no locked messaging npm cache seed");
    expect(existsSync(dockerLog)).toBe(false);
  });

  it("rejects an imported cache that omits the locked MCP runtime npm seed", () => {
    const cacheRoot = path.join(testRoot, "imported-cache");
    completeImportedCache(cacheRoot);
    rmSync(path.join(cacheRoot, "mcp-runtime-npm-cache-seed"), { recursive: true });

    const result = runBuild(REPO_ROOT, ["--cache-from", cacheRoot]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("imported cache has no locked MCP runtime npm cache seed");
    expect(existsSync(dockerLog)).toBe(false);
  });

  it("imports locked seeds, reuses safe agent caches, and disables RUN network access", () => {
    const cacheRoot = path.join(testRoot, "imported-cache");
    const sourceSeed = path.join(REPO_ROOT, "tools/mcp-tool-discovery-runtime/npm-cache-seed");
    const sourceMessagingSeed = path.join(
      REPO_ROOT,
      "agents/openclaw/managed-image-messaging-runtime/npm-cache-seed",
    );
    const sourceMcpSeed = path.join(
      REPO_ROOT,
      "tools/mcp-tool-discovery-runtime/mcp-runtime-npm-cache-seed",
    );
    const originalSeedNames = readdirSync(sourceSeed).sort();
    const originalMcpSeedNames = readdirSync(sourceMcpSeed).sort();
    const originalMessagingSeedNames = readdirSync(sourceMessagingSeed).sort();
    completeImportedCache(cacheRoot);
    stubBuildInvocation();

    const result = runBuild(REPO_ROOT, ["--cache-from", cacheRoot]);

    expect(result.status, result.stderr).toBe(0);
    expect(recordedBuildInvocations()).toHaveLength(3);
    expect({
      openclaw: recordedBuildInvocation("openclaw"),
      hermes: recordedBuildInvocation("hermes"),
      "langchain-deepagents-code": recordedBuildInvocation("langchain-deepagents-code"),
    }).toEqual({
      openclaw: expect.stringContaining("--network none"),
      hermes: expect.stringContaining("--network none"),
      "langchain-deepagents-code": expect.stringContaining("--network none"),
    });
    expect(recordedBuildInvocation("openclaw")).not.toContain("--cache-from");
    expect({
      hermes: recordedBuildInvocation("hermes"),
      "langchain-deepagents-code": recordedBuildInvocation("langchain-deepagents-code"),
    }).toEqual({
      hermes: expect.stringContaining(
        `--cache-from type=local,src=${realpathSync(cacheRoot)}/hermes`,
      ),
      "langchain-deepagents-code": expect.stringContaining(
        `--cache-from type=local,src=${realpathSync(cacheRoot)}/langchain-deepagents-code`,
      ),
    });
    expect(recordedBuildInvocation("openclaw").split(" ")).toContain("--no-cache");
    expect(recordedBuildInvocation("hermes").split(" ")).not.toContain("--no-cache");
    expect(recordedBuildInvocation("langchain-deepagents-code").split(" ")).not.toContain(
      "--no-cache",
    );
    expect(readFileSync(seedLog, "utf8")).toContain(
      `materialize-locked-npm-cache-seed.mts copy --lockfile ${REPO_ROOT}/nemoclaw/package-lock.json --seed ${realpathSync(cacheRoot)}/npm-cache-seed`,
    );
    expect(readFileSync(seedLog, "utf8")).toContain(
      `materialize-locked-npm-cache-seed.mts copy --lockfile ${REPO_ROOT}/tools/mcp-tool-discovery-runtime/package-lock.json --seed ${realpathSync(cacheRoot)}/mcp-runtime-npm-cache-seed`,
    );
    expect(readFileSync(seedLog, "utf8")).toContain(
      `materialize-locked-npm-cache-seed.mts copy --lockfile ${REPO_ROOT}/agents/openclaw/managed-image-messaging-runtime/package-lock.json --seed ${realpathSync(cacheRoot)}/messaging-npm-cache-seed`,
    );
    expect(readdirSync(sourceSeed).sort()).toEqual(originalSeedNames);
    expect(readdirSync(sourceMcpSeed).sort()).toEqual(originalMcpSeedNames);
    expect(readdirSync(sourceMessagingSeed).sort()).toEqual(originalMessagingSeedNames);
  });

  it("rejects a nested symlink in a complete imported cache before invoking Docker", () => {
    const cacheRoot = path.join(testRoot, "imported-cache");
    completeImportedAgentCaches(cacheRoot);

    symlinkSync(
      path.join(cacheRoot, "hermes", "index.json"),
      path.join(cacheRoot, "openclaw", "blobs", "sha256", "nested-link"),
    );

    const result = runBuild(REPO_ROOT, ["--cache-from", cacheRoot]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("imported cache contains a symlink");
    expect(existsSync(dockerLog)).toBe(false);
  });
});

describe("protected managed-image build retry", () => {
  it("repeats the exact desired build after the isolated registry reports the revision tag absent (#9763)", () => {
    stubBuildInvocation();
    dockerBuildFailureMode = "exact-once";
    registryStatus = "404";

    const result = runBuild(REPO_ROOT);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(recordedBuildInvocations()).toHaveLength(4);
    expect(recordedBuildInvocations()[1]).toBe(recordedBuildInvocations()[0]);
    expect(readFileSync(registryLog, "utf8").trim()).toBe(
      `--silent --show-error --output /dev/null --write-out %{http_code} --head --connect-timeout 5 --max-time 15 --header Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json http://localhost:5000/v2/nemoclaw-managed-protected/openclaw/manifests/${REVISION}`,
    );
    expect(output).toContain(
      "Protected managed-image build retry state agent=openclaw revision-tag=absent",
    );
    expect(output).toContain(
      "outcome=transient-external agent=openclaw attempt=1/2 retry-in=2s failure=buildkit-http2-internal-error",
    );
    expect(output).toContain("outcome=passed-after-retry agent=openclaw attempt=2/2");
  });

  it("keeps a present revision tag terminal after an ambiguous build failure (#9763)", () => {
    stubBuildInvocation();
    dockerBuildFailureMode = "exact-once";
    registryStatus = "200";

    const result = runBuild(REPO_ROOT);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(42);
    expect(recordedBuildInvocations()).toHaveLength(1);
    expect(output).toContain(
      "Protected managed-image build retry state agent=openclaw revision-tag=present",
    );
    expect(output).toContain(
      "outcome=failed-no-retry agent=openclaw attempt=1/2 failure=state-check",
    );
    expect(output).not.toContain("outcome=transient-external");
  });

  it("keeps a near-match BuildKit failure terminal (#9763)", () => {
    stubBuildInvocation();
    dockerBuildFailureMode = "near-match";

    const result = runBuild(REPO_ROOT);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(42);
    expect(recordedBuildInvocations()).toHaveLength(1);
    expect(existsSync(registryLog)).toBe(false);
    expect(output).toContain("outcome=failed-no-retry agent=openclaw attempt=1/2 docker-exit=42");
  });

  it("retries an exact npm registry DNS failure after the revision tag is absent", () => {
    stubBuildInvocation();
    dockerBuildFailureMode = "npm-registry-dns-once";
    registryStatus = "404";

    const result = runBuild(REPO_ROOT);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(recordedBuildInvocations()).toHaveLength(4);
    expect(recordedBuildInvocations()[1]).toBe(recordedBuildInvocations()[0]);
    expect(output).toContain(
      "outcome=transient-external agent=openclaw attempt=1/2 retry-in=2s failure=npm-registry-dns-resolution",
    );
    expect(output).toContain("outcome=passed-after-retry agent=openclaw attempt=2/2");
  });

  it("keeps a near-match npm registry DNS failure terminal", () => {
    stubBuildInvocation();
    dockerBuildFailureMode = "npm-registry-dns-near-match";

    const result = runBuild(REPO_ROOT);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(42);
    expect(recordedBuildInvocations()).toHaveLength(1);
    expect(existsSync(registryLog)).toBe(false);
    expect(output).toContain("outcome=failed-no-retry agent=openclaw attempt=1/2 docker-exit=42");
  });

  it("stops when the revision-tag state is inconclusive (#9763)", () => {
    stubBuildInvocation();
    dockerBuildFailureMode = "exact-once";
    registryStatus = "503";

    const result = runBuild(REPO_ROOT);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(42);
    expect(recordedBuildInvocations()).toHaveLength(1);
    expect(output).toContain(
      "Protected managed-image build retry state check failed agent=openclaw registry-http=503",
    );
    expect(output).toContain(
      "outcome=failed-no-retry agent=openclaw attempt=1/2 failure=state-check",
    );
  });

  it("stops when the revision-tag state check loses transport (#9763)", () => {
    stubBuildInvocation();
    dockerBuildFailureMode = "exact-once";
    registryCurlExit = "7";
    registryStatus = "000";

    const result = runBuild(REPO_ROOT);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(42);
    expect(recordedBuildInvocations()).toHaveLength(1);
    expect(output).toContain(
      "Protected managed-image build retry state check failed agent=openclaw transport=curl",
    );
    expect(output).toContain(
      "outcome=failed-no-retry agent=openclaw attempt=1/2 failure=state-check",
    );
  });

  it("keeps an attempt-evidence write failure terminal (#9763)", () => {
    stubBuildInvocation();
    teeFailureMode = "always";

    const result = runBuild(REPO_ROOT);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(43);
    expect(recordedBuildInvocations()).toHaveLength(1);
    expect(existsSync(registryLog)).toBe(false);
    expect(output).toContain("outcome=failed-no-retry agent=openclaw attempt=1/2 evidence-exit=43");
  });

  it("keeps repeated exact BuildKit failures failed after one retry (#9763)", () => {
    stubBuildInvocation();
    dockerBuildFailureMode = "exact-always";

    const result = runBuild(REPO_ROOT);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(42);
    expect(recordedBuildInvocations()).toHaveLength(2);
    expect(output).toContain(
      "outcome=exhausted agent=openclaw attempt=2/2 failure=buildkit-http2-internal-error docker-exit=42",
    );
  });

  it("keeps repeated exact npm registry DNS failures failed after one retry", () => {
    stubBuildInvocation();
    dockerBuildFailureMode = "npm-registry-dns-always";

    const result = runBuild(REPO_ROOT);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(42);
    expect(recordedBuildInvocations()).toHaveLength(2);
    expect(output).toContain(
      "outcome=exhausted agent=openclaw attempt=2/2 failure=npm-registry-dns-resolution docker-exit=42",
    );
  });
});
