// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLiveVitestArgs,
  HERMES_SECURITY_POSTURE_SWAP_BYTES,
  LIVE_VITEST_PROJECT,
  type LiveVitestSpawner,
  needsHermesSecurityPostureSwap,
  RISK_SIGNAL_REPORTER,
  runLiveVitestCommand,
  validateLiveProject,
  validateLiveSelector,
  validateLiveTestPath,
} from "../../../tools/e2e/live-vitest-invocation.mts";

const LIVE_VITEST_TOOL = path.resolve("tools/e2e/live-vitest-invocation.mts");
const TSX = path.resolve("node_modules", ".bin", "tsx");

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

  it("treats an absent or empty selector as no selector", () => {
    expect(validateLiveSelector(undefined)).toBeUndefined();
    expect(validateLiveSelector("")).toBeUndefined();
    expect(validateLiveSelector("   ")).toBeUndefined();
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
});

describe("buildLiveVitestArgs (#6961)", () => {
  it("builds the standard invocation with a selector", () => {
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

  it("omits the selector arguments for a single-file target", () => {
    expect(
      buildLiveVitestArgs({
        testPath: "test/e2e/live/diagnostics.test.ts",
      }),
    ).toEqual([
      "vitest",
      "run",
      "--project",
      "e2e-live",
      "test/e2e/live/diagnostics.test.ts",
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

describe("runLiveVitestCommand (#6961)", () => {
  const validArgs = ["run", "--test-path", "test/e2e/live/diagnostics.test.ts"];

  it.each([
    ["child status", { status: 7, signal: null }, 7],
    ["child signal", { status: null, signal: "SIGTERM" as NodeJS.Signals }, 143],
    ["missing status and signal", { status: null, signal: null }, 1],
  ])("preserves %s", (_label, result, expected) => {
    let spawned: Parameters<LiveVitestSpawner> | undefined;
    const spawn: LiveVitestSpawner = (...args) => {
      spawned = args;
      return result;
    };

    expect(runLiveVitestCommand(validArgs, spawn)).toBe(expected);
    expect(spawned).toEqual([
      "npx",
      [
        "vitest",
        "run",
        "--project",
        "e2e-live",
        "test/e2e/live/diagnostics.test.ts",
        "--silent=false",
        "--reporter=default",
        `--reporter=${RISK_SIGNAL_REPORTER}`,
      ],
      { stdio: "inherit" },
    ]);
  });

  it("surfaces child launch failures", () => {
    const launchError = new Error("spawn npx ENOENT");
    const spawn: LiveVitestSpawner = () => ({
      status: null,
      signal: null,
      error: launchError,
    });

    expect(() => runLiveVitestCommand(validArgs, spawn)).toThrow(launchError);
  });

  it("provisions bounded swap before hosted Hermes security posture", () => {
    const calls: Array<Parameters<LiveVitestSpawner>> = [];
    const spawn: LiveVitestSpawner = (...args) => {
      calls.push(args);
      return { status: 0 };
    };
    const env = {
      GITHUB_ACTIONS: "true",
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_E2E_SECURITY_POSTURE: "1",
    };

    expect(
      runLiveVitestCommand(["run", "--test-path", "test/e2e/live/hermes-e2e.test.ts"], spawn, env),
    ).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe("sudo");
    expect(calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "bash",
        "-c",
        "hermes-security-posture-swap",
        "/mnt/nemoclaw-hermes-security-posture.swap",
        String(HERMES_SECURITY_POSTURE_SWAP_BYTES),
      ]),
    );
    expect(calls[0]?.[1][2]).toContain('fallocate -l "$swap_size_bytes" "$swap_file"');
    expect(calls[0]?.[1][2]).toContain('swapon "$swap_file"');
    expect(calls[1]?.[0]).toBe("npx");
  });

  it("fails closed before Vitest when Hermes swap provisioning fails", () => {
    const calls: string[] = [];
    const spawn: LiveVitestSpawner = (command) => {
      calls.push(command);
      return { status: 23 };
    };

    expect(
      runLiveVitestCommand(["run", "--test-path", "test/e2e/live/hermes-e2e.test.ts"], spawn, {
        GITHUB_ACTIONS: "true",
        NEMOCLAW_AGENT: "hermes",
        NEMOCLAW_E2E_SECURITY_POSTURE: "true",
      }),
    ).toBe(23);
    expect(calls).toEqual(["sudo"]);
  });

  it.each([
    [
      "unknown option",
      ["run", "--test-path", "test/e2e/live/diagnostics.test.ts", "--selctor", "^x$"],
    ],
    ["bare selector", [...validArgs, "--selector"]],
  ])("rejects an %s before spawning Vitest", (_label, args) => {
    let spawned = false;
    const spawn: LiveVitestSpawner = () => {
      spawned = true;
      return { status: 0 };
    };

    expect(() => runLiveVitestCommand(args, spawn)).toThrow(/unsupported.*option|requires a value/);
    expect(spawned).toBe(false);
  });

  it("rejects a repeated supported option before spawning Vitest", () => {
    let spawned = false;
    const spawn: LiveVitestSpawner = () => {
      spawned = true;
      return { status: 0 };
    };

    expect(() =>
      runLiveVitestCommand(
        [...validArgs, "--test-path", "test/e2e/live/registry-targets.test.ts"],
        spawn,
      ),
    ).toThrow(/must not be repeated/);
    expect(spawned).toBe(false);
  });

  it.each([
    ["missing", []],
    ["unsupported", ["runx"]],
  ])("fails the workflow CLI for a %s subcommand", (_label, args) => {
    const result = spawnSync(TSX, [LIVE_VITEST_TOOL, ...args], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected "run"');
  });
});

describe("needsHermesSecurityPostureSwap", () => {
  const testPath = "test/e2e/live/hermes-e2e.test.ts";
  const matchingEnv = {
    GITHUB_ACTIONS: "true",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_E2E_SECURITY_POSTURE: "1",
  };

  it("matches only the hosted Hermes posture invocation", () => {
    expect(needsHermesSecurityPostureSwap(testPath, matchingEnv)).toBe(true);
    expect(needsHermesSecurityPostureSwap("test/e2e/live/full-e2e.test.ts", matchingEnv)).toBe(
      false,
    );
    expect(needsHermesSecurityPostureSwap(testPath, { ...matchingEnv, GITHUB_ACTIONS: "" })).toBe(
      false,
    );
    expect(
      needsHermesSecurityPostureSwap(testPath, { ...matchingEnv, NEMOCLAW_AGENT: "openclaw" }),
    ).toBe(false);
    expect(
      needsHermesSecurityPostureSwap(testPath, {
        ...matchingEnv,
        NEMOCLAW_E2E_SECURITY_POSTURE: "",
      }),
    ).toBe(false);
  });
});
