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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const compiler = join(import.meta.dirname, "../../.github/actions/ci-compile-artifacts/compile.sh");
const temporaryRoots: string[] = [];
type Fixture = { root: string; path: string; trace: string };

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-ci-compile-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const trace = join(root, "commands.trace");
  mkdirSync(bin);
  mkdirSync(join(root, "nemoclaw"));
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  writeFileSync(join(root, "nemoclaw", "package-lock.json"), "{}\n");
  for (const command of ["npm", "npx"]) {
    const executable = join(bin, command);
    writeFileSync(
      executable,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s %s\\n" "$(basename "$0")" "$*" >> "$COMMAND_TRACE"',
        'if [ "${FAIL_COMMAND:-}" = "$(basename "$0") $*" ]; then exit 19; fi',
        'if [ "$*" = "run build:cli" ]; then mkdir -p dist; printf "built\\n" > dist/nemoclaw.js; fi',
        'if [ "$*" = "--prefix nemoclaw run build" ]; then',
        "  mkdir -p nemoclaw/dist/shared",
        '  printf "built\\n" > nemoclaw/dist/index.js',
        '  if [ "${SKIP_PLUGIN_OUTPUT:-}" != "1" ]; then printf "built\\n" > nemoclaw/dist/shared/sandbox-name.cjs; fi',
        "fi",
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
  }
  return { root, path: bin + ":" + (process.env.PATH ?? ""), trace };
}

function runCompiler(fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [compiler], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      COMMAND_TRACE: fixture.trace,
      GITHUB_WORKSPACE: fixture.root,
      PATH: fixture.path,
    },
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("trusted CI artifact compiler", () => {
  it("compiles and verifies fixed CLI and plugin outputs in the caller workspace", () => {
    const fixture = makeFixture();
    const result = runCompiler(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.trace, "utf8").trim().split("\n")).toEqual([
      "npm run clean:cli",
      "npm --prefix nemoclaw run clean",
      "npm --prefix nemoclaw run build",
      "npm run build:cli",
      "npx tsx scripts/check-dist-sourcemaps.mts dist",
    ]);
  });

  it("stops before verification when candidate compilation fails", () => {
    const fixture = makeFixture();
    const result = runCompiler(fixture, { FAIL_COMMAND: "npm run build:cli" });
    expect(result.status).toBe(19);
    expect(readFileSync(fixture.trace, "utf8")).not.toContain("check-dist-sourcemaps");
  });

  it("propagates CLI sourcemap validation failure", () => {
    const fixture = makeFixture();
    const result = runCompiler(fixture, {
      FAIL_COMMAND: "npx tsx scripts/check-dist-sourcemaps.mts dist",
    });
    expect(result.status).toBe(19);
  });

  it("rejects an unset caller workspace before candidate commands run", () => {
    const fixture = makeFixture();
    const result = spawnSync("bash", [compiler], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        ...process.env,
        COMMAND_TRACE: fixture.trace,
        GITHUB_WORKSPACE: "",
        PATH: fixture.path,
      },
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.trace)).toBe(false);
  });

  it("rejects a checkout that lacks a fixed lockfile before candidate commands run", () => {
    const fixture = makeFixture();
    rmSync(join(fixture.root, "nemoclaw", "package-lock.json"));
    const result = runCompiler(fixture);
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.trace)).toBe(false);
  });

  it("rejects an incomplete compiled plugin output", () => {
    const fixture = makeFixture();
    const result = runCompiler(fixture, { SKIP_PLUGIN_OUTPUT: "1" });
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.trace, "utf8")).toContain("npm run build:cli");
  });
});
