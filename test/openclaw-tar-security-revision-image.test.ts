// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runImageTests = process.env.NEMOCLAW_RUN_OPENCLAW_TAR_REVISION_IMAGE_TESTS === "1";
const cases = [
  {
    name: "oldest nested layout without a shrinkwrap",
    baseImage:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3d9391e6c27c986f4ded2e36c874b5f16f59001cdda3415daa48a43ccb5a2ed3",
    openClawVersion: "2026.5.18",
    shrinkwrap: "absent",
  },
  {
    name: "direct-only tar layout",
    baseImage:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:70e6de8cd9c2526c8ba1cfc1b46f65f0c8773924e413493d3af6b639bcbda4df",
    openClawVersion: "2026.5.27",
    shrinkwrap: "present",
  },
  {
    name: "nested fs-safe tar layout",
    baseImage:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1",
    openClawVersion: "2026.6.10",
    shrinkwrap: "present",
  },
] as const;

function docker(args: string[]) {
  return spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
}

describe.runIf(runImageTests)("OpenClaw tar security revision image integration (#7272)", () => {
  it.each(cases)(
    "builds and executes the $name",
    ({ baseImage, openClawVersion, shrinkwrap }) => {
      const image = `nemoclaw-openclaw-tar-revision-test:${openClawVersion}-${process.pid}`;
      try {
        const build = docker([
          "build",
          "-f",
          "Dockerfile.openclaw-tar-security-revision",
          "--build-arg",
          `BASE_IMAGE=${baseImage}`,
          "--build-arg",
          `EXPECTED_OPENCLAW_VERSION=${openClawVersion}`,
          "-t",
          image,
          ".",
        ]);
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

        const probe = docker([
          "run",
          "--rm",
          "--entrypoint",
          "bash",
          image,
          "-lc",
          [
            "set -euo pipefail",
            "openclaw --version | awk '{print $2}'",
            "test -e /usr/local/lib/node_modules/openclaw/npm-shrinkwrap.json && echo present || echo absent",
            "find /usr/local/lib/node_modules/openclaw -path '*/node_modules/tar/package.json' -exec node -p 'require(process.argv[1]).version' {} \\;",
            "test -r /usr/local/share/nemoclaw/openclaw-tar-cve-2026-59873-v1",
          ].join("; "),
        ]);
        expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
        const versions = probe.stdout.trim().split("\n");
        expect(versions[0]).toBe(openClawVersion);
        expect(versions[1]).toBe(shrinkwrap);
        expect(new Set(versions.slice(2))).toEqual(new Set(["7.5.19"]));
      } finally {
        docker(["image", "rm", "--force", image]);
      }
    },
    10 * 60 * 1000,
  );
});
