// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts/checks/build-protected-managed-images.sh");
const REVISION = "a".repeat(40);
const DIGEST = "b".repeat(64);

let testRoot = "";
let stubBin = "";
let dockerLog = "";

function writeExecutable(name: string, source: string): void {
  const target = path.join(stubBin, name);
  writeFileSync(target, source, "utf8");
  chmodSync(target, 0o755);
}

function stubBuildInvocation(): void {
  writeExecutable(
    "docker",
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$NEMOCLAW_TEST_DOCKER_LOG"\ncase "$*" in\n  "buildx imagetools inspect "*) printf "{}\\n" ;;\n  "buildx build "*) ;;\n  "pull "*) ;;\n  "image inspect "*) printf "[]\\n" ;;\n  *) exit 91 ;;\nesac\n',
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

function runBuild(sourceRoot: string, extraArgs: readonly string[] = []) {
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
      "linux/amd64",
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
        NEMOCLAW_TEST_DOCKER_LOG: dockerLog,
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
    mkdirSync(sourceRoot);

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
  it("builds every agent without optional cache arguments", () => {
    stubBuildInvocation();

    const result = runBuild(REPO_ROOT);

    expect(result.status, result.stderr).toBe(0);
    expect(recordedBuildInvocations()).toHaveLength(3);
    for (const invocation of recordedBuildInvocations()) {
      expect(invocation).not.toContain("--cache-to");
      expect(invocation).not.toContain("--cache-from");
      expect(invocation).not.toContain("--network none");
    }
  });

  it("passes each agent one empty absolute cache export root", () => {
    const cacheRoot = path.join(testRoot, "export-cache");
    stubBuildInvocation();

    const result = runBuild(REPO_ROOT, ["--cache-to", cacheRoot]);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(cacheRoot)).toBe(true);
    expect(recordedBuildInvocations()).toHaveLength(3);
    for (const agent of ["openclaw", "hermes", "langchain-deepagents-code"]) {
      expect(recordedBuildInvocation(agent)).toContain(
        `--cache-to type=local,dest=${realpathSync(cacheRoot)}/${agent},mode=max`,
      );
    }
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

  it("rejects an incomplete offline cache before invoking Docker", () => {
    const cacheRoot = path.join(testRoot, "offline-cache");
    mkdirSync(cacheRoot);

    const result = runBuild(REPO_ROOT, ["--offline-cache", cacheRoot]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("offline cache is incomplete for openclaw");
    expect(existsSync(dockerLog)).toBe(false);
  });

  it("passes each agent complete offline cache metadata with network disabled", () => {
    const cacheRoot = path.join(testRoot, "offline-cache");
    for (const agent of ["openclaw", "hermes", "langchain-deepagents-code"]) {
      mkdirSync(path.join(cacheRoot, agent, "blobs", "sha256"), {
        recursive: true,
      });
      writeFileSync(path.join(cacheRoot, agent, "index.json"), "{}\n", "utf8");
    }
    stubBuildInvocation();

    const result = runBuild(REPO_ROOT, ["--offline-cache", cacheRoot]);

    expect(result.status, result.stderr).toBe(0);
    expect(recordedBuildInvocations()).toHaveLength(3);
    for (const agent of ["openclaw", "hermes", "langchain-deepagents-code"]) {
      expect(recordedBuildInvocation(agent)).toContain(
        `--cache-from type=local,src=${realpathSync(cacheRoot)}/${agent} --network none`,
      );
    }
  });

  it("rejects a nested symlink in a complete offline cache before invoking Docker", () => {
    const cacheRoot = path.join(testRoot, "offline-cache");
    for (const agent of ["openclaw", "hermes", "langchain-deepagents-code"]) {
      mkdirSync(path.join(cacheRoot, agent, "blobs", "sha256"), {
        recursive: true,
      });
      writeFileSync(path.join(cacheRoot, agent, "index.json"), "{}\n", "utf8");
    }
    symlinkSync(
      path.join(cacheRoot, "hermes", "index.json"),
      path.join(cacheRoot, "openclaw", "blobs", "sha256", "nested-link"),
    );

    const result = runBuild(REPO_ROOT, ["--offline-cache", cacheRoot]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("offline cache contains a symlink");
    expect(existsSync(dockerLog)).toBe(false);
  });
});
