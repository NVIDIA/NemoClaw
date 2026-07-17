// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildLiveVitestArgs,
  LIVE_VITEST_PROJECT,
  RISK_SIGNAL_REPORTER,
  resolveChildExitCode,
  validateLiveProject,
  validateLiveSelector,
  validateLiveTestPath,
} from "../../../tools/e2e/live-vitest-invocation.mts";

const HELPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tools/e2e/live-vitest-invocation.mts",
);

function runHelper(args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", HELPER, ...args], {
    encoding: "utf-8",
  });
}

describe("validateLiveProject (#6961)", () => {
  it("accepts the live project and defaults to it", () => {
    expect(validateLiveProject("e2e-live")).toBe(LIVE_VITEST_PROJECT);
    expect(validateLiveProject(undefined)).toBe(LIVE_VITEST_PROJECT);
  });

  it("rejects any other project", () => {
    for (const project of ["cli", "e2e-support", "e2e-live-extra", "integration"]) {
      expect(() => validateLiveProject(project)).toThrow(/unsupported vitest project/);
    }
  });
});

describe("validateLiveTestPath (#6961)", () => {
  it("accepts a real live test path", () => {
    expect(validateLiveTestPath("test/e2e/live/registry-targets.test.ts")).toBe(
      "test/e2e/live/registry-targets.test.ts",
    );
  });

  it("rejects paths outside the live test root", () => {
    expect(() => validateLiveTestPath("test/e2e/support/thing.test.ts")).toThrow(
      /must be under test\/e2e\/live/,
    );
    expect(() => validateLiveTestPath("src/lib/onboard.ts")).toThrow(/must be under/);
  });

  it("rejects '..' traversal", () => {
    expect(() => validateLiveTestPath("test/e2e/live/../../../etc/passwd")).toThrow(
      /has an unsupported character|traverse/,
    );
    expect(() => validateLiveTestPath("test/e2e/live/../support/x.test.ts")).toThrow(/traverse/);
  });

  it("rejects absolute paths", () => {
    expect(() => validateLiveTestPath("/etc/passwd")).toThrow(/unsupported character|absolute/);
  });

  it("rejects shell metacharacters", () => {
    for (const bad of [
      "test/e2e/live/x.test.ts; rm -rf /",
      "test/e2e/live/$(whoami).test.ts",
      "test/e2e/live/x.test.ts && curl evil",
      "test/e2e/live/`id`.test.ts",
      "test/e2e/live/x.test.ts|cat",
    ]) {
      expect(() => validateLiveTestPath(bad)).toThrow(/unsupported character/);
    }
  });

  it("requires a .test.ts file", () => {
    expect(() => validateLiveTestPath("test/e2e/live/fixtures")).toThrow(/\.test\.ts/);
  });

  it("requires a non-empty path", () => {
    expect(() => validateLiveTestPath("")).toThrow(/required/);
    expect(() => validateLiveTestPath(undefined)).toThrow(/required/);
  });
});

describe("validateLiveSelector (#6961)", () => {
  it("accepts anchored title patterns", () => {
    expect(validateLiveSelector("^ubuntu-repo-cloud-openclaw$")).toBe(
      "^ubuntu-repo-cloud-openclaw$",
    );
    expect(validateLiveSelector("^skill-agent$")).toBe("^skill-agent$");
  });

  it("rejects shell metacharacters in the expanded selector", () => {
    for (const bad of [
      "^$(touch pwned)$",
      "^x$; rm -rf /",
      "^x$ && evil",
      "^`id`$",
      "^x|y$",
      "^x>out$",
    ]) {
      expect(() => validateLiveSelector(bad)).toThrow(/unsupported character/);
    }
  });

  it("requires a non-empty selector", () => {
    expect(() => validateLiveSelector("")).toThrow(/required/);
    expect(() => validateLiveSelector(undefined)).toThrow(/required/);
  });
});

describe("buildLiveVitestArgs (#6961)", () => {
  it("builds the standard invocation from validated inputs", () => {
    expect(
      buildLiveVitestArgs({
        testPath: "test/e2e/live/registry-targets.test.ts",
        selector: "^ubuntu-repo-cloud-openclaw$",
      }),
    ).toEqual([
      "vitest",
      "run",
      "--project",
      "e2e-live",
      "test/e2e/live/registry-targets.test.ts",
      "-t",
      "^ubuntu-repo-cloud-openclaw$",
      "--silent=false",
      "--reporter=default",
      `--reporter=${RISK_SIGNAL_REPORTER}`,
    ]);
  });

  it("fails closed on an invalid input before producing any argv", () => {
    expect(() =>
      buildLiveVitestArgs({
        testPath: "test/e2e/live/x.test.ts",
        selector: "^x$; rm -rf /",
      }),
    ).toThrow(/unsupported character/);
    expect(() =>
      buildLiveVitestArgs({
        testPath: "test/e2e/support/x.test.ts",
        selector: "^x$",
        project: "e2e-live",
      }),
    ).toThrow(/must be under/);
  });
});

describe("CLI subcommand guard (#6961)", () => {
  // A typo must never look like a passing E2E run: the previous guard only ran
  // on `run` and fell through to a silent exit 0 for anything else.
  it.each([
    "runx",
    "ru",
    "RUN",
    "--test-path",
  ])("fails on the unsupported subcommand %j instead of exiting 0", (subcommand) => {
    const result = runHelper([subcommand]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsupported subcommand/);
    expect(result.stderr).toMatch(/usage: live-vitest-invocation\.mts run/);
  });

  it("fails when no subcommand is given", () => {
    const result = runHelper([]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/missing subcommand/);
  });

  it("rejects an invalid selector through the CLI rather than running vitest", () => {
    const result = runHelper([
      "run",
      "--test-path",
      "test/e2e/live/registry-targets.test.ts",
      "--selector",
      "^x$; rm -rf /",
    ]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/unsupported character/);
  });
});

describe("resolveChildExitCode (termination behavior, #6961)", () => {
  it("passes a normal exit status straight through", () => {
    expect(resolveChildExitCode({ status: 0 })).toBe(0);
    expect(resolveChildExitCode({ status: 1 })).toBe(1);
    expect(resolveChildExitCode({ status: 137 })).toBe(137);
  });

  it("maps a signal death to 128+signo like the shell it replaced", () => {
    expect(resolveChildExitCode({ status: null, signal: "SIGKILL" })).toBe(
      128 + (os.constants.signals.SIGKILL as number),
    );
    expect(resolveChildExitCode({ status: null, signal: "SIGTERM" })).toBe(
      128 + (os.constants.signals.SIGTERM as number),
    );
  });

  it("reports a spawn failure as a generic failure", () => {
    expect(resolveChildExitCode({ status: null, error: new Error("ENOENT") })).toBe(1);
    expect(resolveChildExitCode({ status: null })).toBe(1);
  });
});
