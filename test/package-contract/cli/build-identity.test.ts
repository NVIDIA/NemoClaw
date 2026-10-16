// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getBuildIdentity } from "../../../dist/lib/core/version";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..", "..");

// Reports every child_process call that the launched CLI makes.
const SPAWN_REPORTER = `
const childProcess = require("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function (...args) {
    process.stderr.write("child_process." + name + " " + String(args[0]) + "\\n");
    return original.apply(this, args);
  };
}
`;

describe("compiled CLI build identity", () => {
  it("reports one immutable version and source revision (#7777)", () => {
    const identity = getBuildIdentity({ rootDir: REPOSITORY_ROOT });
    const versionOutput = execFileSync(
      process.execPath,
      [path.join(REPOSITORY_ROOT, "bin", "nemoclaw.js"), "--version"],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
      },
    ).trim();

    expect(versionOutput).toBe(`nemoclaw v${identity.nemoclawVersion}`);
    expect(identity.sourceRevision).toMatch(/^[0-9a-f]{40,64}$/);
    const describedRevision = /-\d+-g([0-9a-f]{7,64})$/.exec(identity.nemoclawVersion)?.[1];
    expect(
      describedRevision === undefined || identity.sourceRevision.startsWith(describedRevision),
    ).toBe(true);
  }, 15_000);

  it.each(["--version", "-v", "version"])(
    "prints %s without starting a child process (#12002)",
    (versionArg) => {
      const identity = getBuildIdentity({ rootDir: REPOSITORY_ROOT });
      const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-version-spawns-"));
      const hook = path.join(hookDir, "report-spawns.cjs");
      fs.writeFileSync(hook, SPAWN_REPORTER);
      try {
        const result = spawnSync(
          process.execPath,
          ["--require", hook, path.join(REPOSITORY_ROOT, "bin", "nemoclaw.js"), versionArg],
          {
            cwd: REPOSITORY_ROOT,
            encoding: "utf8",
            env: { ...process.env, NEMOCLAW_GATEWAY_PORT: "" },
          },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`nemoclaw v${identity.nemoclawVersion}\n`);
        expect(result.stderr).not.toContain("child_process.");
      } finally {
        fs.rmSync(hookDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
