// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("shared CI dependency installer", () => {
  it("installs root and plugin dependencies from lockfiles without lifecycle scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-ci-install-"));
    temporaryRoots.push(root);
    const bin = join(root, "bin");
    const trace = join(root, "npm.trace");
    mkdirSync(bin);
    const npm = join(bin, "npm");
    writeFileSync(npm, `#!/bin/sh\nprintf '%s\n' "$*" >> "$NPM_TRACE"\n`);
    chmodSync(npm, 0o755);

    const result = spawnSync("bash", [".github/actions/ci-install-dependencies.sh"], {
      cwd: join(import.meta.dirname, "../.."),
      encoding: "utf8",
      env: { ...process.env, NPM_TRACE: trace, PATH: `${bin}:${process.env.PATH || ""}` },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual([
      "ci --ignore-scripts",
      "--prefix nemoclaw ci --ignore-scripts",
    ]);
  });
});
