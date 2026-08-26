// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const installer = join(import.meta.dirname, "../../.github/actions/ci-install-dependencies.sh");

function makeFixture(): { root: string; trace: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-ci-install-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const trace = join(root, "npm.trace");
  mkdirSync(bin);
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!/bin/sh\nprintf '%s\n' "$*" >> "$NPM_TRACE"\n`);
  chmodSync(npm, 0o755);
  return { root, trace, path: `${bin}:${process.env.PATH || ""}` };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("shared CI dependency installer", () => {
  it("installs root and plugin dependencies from lockfiles without lifecycle scripts", () => {
    const fixture = makeFixture();

    const result = spawnSync("bash", [installer], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, NPM_TRACE: fixture.trace, PATH: fixture.path },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.trace, "utf8").trim().split("\n")).toEqual([
      "ci --ignore-scripts",
      "--prefix nemoclaw ci --ignore-scripts",
    ]);
  });

  it("rejects candidate npm configuration before npm receives the package token", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.root, "nemoclaw"));
    writeFileSync(join(fixture.root, "nemoclaw", ".npmrc"), "@nvidia:registry=https://example.invalid\n");

    const result = spawnSync("bash", [installer], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: "credential-sentinel",
        NPM_TRACE: fixture.trace,
        PATH: fixture.path,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Candidate repository npm configuration is not allowed during trusted dependency installation.\n",
    );
    expect(result.stderr).not.toContain("credential-sentinel");
    expect(existsSync(fixture.trace)).toBe(false);
  });
});
