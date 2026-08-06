// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPackageFixture } from "./helpers/package-fixture";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const CLI_ENTRYPOINT = path.join(REPOSITORY_ROOT, "bin", "nemoclaw.js");
const fixtureRoots: string[] = [];

afterEach(() => {
  fixtureRoots
    .splice(0)
    .forEach((fixtureRoot) => rmSync(fixtureRoot, { force: true, recursive: true }));
});

function runCli(...args: string[]): ReturnType<typeof spawnSync> {
  const fixtureHome = createPackageFixture({
    prefix: "nemoclaw-deterministic-smoke-home-",
    entries: [],
  });
  fixtureRoots.push(fixtureHome);
  return spawnSync(process.execPath, [CLI_ENTRYPOINT, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixtureHome,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NO_COLOR: "1",
    },
    timeout: 30_000,
  });
}

describe("deterministic PR smoke floor", () => {
  it("starts the compiled CLI without credentials, containers, or external services", () => {
    const version = runCli("--version");
    const help = runCli("--help");

    expect(version.error).toBeUndefined();
    expect(version.signal).toBeNull();
    expect(version.status, String(version.stderr)).toBe(0);
    expect(version.stdout).toMatch(/^nemoclaw v/u);
    expect(help.error).toBeUndefined();
    expect(help.signal).toBeNull();
    expect(help.status, String(help.stderr)).toBe(0);
    expect(help.stdout).toContain("Getting Started:");
    expect(help.stdout).toContain("nemoclaw onboard");
  });

  it("packs the compiled CLI and plugin entrypoints from reviewed package metadata", {
    timeout: 30_000,
  }, () => {
    const packageRoot = createPackageFixture({
      prefix: "nemoclaw-deterministic-smoke-package-",
      entries: [
        "bin",
        "dist",
        "nemoclaw/dist",
        "nemoclaw/openclaw.plugin.json",
        "nemoclaw/package.json",
      ],
    });
    fixtureRoots.push(packageRoot);
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(packed.error).toBeUndefined();
    expect(packed.signal).toBeNull();
    expect(packed.status, packed.stderr).toBe(0);
    const report = JSON.parse(packed.stdout) as Array<{ files?: Array<{ path?: string }> }>;
    const files = new Set((report[0]?.files ?? []).map((entry) => entry.path));
    expect(files.has("bin/nemoclaw.js")).toBe(true);
    expect(files.has("dist/nemoclaw.js")).toBe(true);
    expect(files.has("nemoclaw/dist/index.js")).toBe(true);
    expect(files.has("nemoclaw/openclaw.plugin.json")).toBe(true);
  });
});
