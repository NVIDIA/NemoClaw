// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

function runBuild(sourceRoot: string) {
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
