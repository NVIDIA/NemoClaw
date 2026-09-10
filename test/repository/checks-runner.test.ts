// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildCheckSpawnInvocation,
  CHECKS,
  runChecks,
  selectChecks,
} from "../../scripts/checks/run.mts";

const sampleCheck = {
  name: "sample",
  command: "tsx.cmd",
  args: ["scripts/checks/sample.mts"],
};

function successfulSpawn(): { status: number | null } {
  return { status: 0 };
}

describe("checks runner", () => {
  it("runs every check when no changed-file selection is supplied", () => {
    expect(selectChecks(CHECKS)).toEqual(CHECKS);
  });

  it("keeps dynamic checks when an unrelated document changes", () => {
    expect(selectChecks(CHECKS, ["docs/overview.mdx"]).map((check) => check.name)).toEqual([
      "optimized-build-context-copy-sources",
      "pi-qualification-receipt-refresh",
    ]);
  });

  it("selects source checks without unrelated test and Hermes scans", () => {
    expect(selectChecks(CHECKS, ["src/commands/status.ts"]).map((check) => check.name)).toEqual([
      "no-defaulted-dependent-flags",
      "no-coverage-ignore",
      "layer-import-boundaries",
      "source-architecture",
      "no-test-dist-imports",
      "test-create-require-budget",
      "optimized-build-context-copy-sources",
      "pi-qualification-receipt-refresh",
      "test-registration-boundary",
    ]);
  });

  it.each([
    "scripts/checks/run.mts",
    "scripts/lib/dockerfile-copy-sources.mts",
    "test/helpers/fixture.ts",
    "ci/source-architecture-budget.json",
    "package-lock.json",
    "nemoclaw/package.json",
    "vitest.config.ts",
    "nemoclaw/tsconfig.test.json",
    ".pre-commit-config.yaml",
  ])("runs every check when shared input %s changes", (file) => {
    expect(selectChecks(CHECKS, [file])).toEqual(CHECKS);
  });

  it.each([
    ["src/lib/security/credential-env.ts", "direct-credential-env"],
    ["docs/resources/local-credential-form.html", "local-credential-helper-pin"],
    ["src/lib/domain/sandbox/connect-env.ts", "hermes-light-skin-boundary"],
    ["agents/hermes/Dockerfile.base", "dependency-pins"],
    ["src/lib/onboard.ts", "onboard-entry-composition"],
    ["src/lib/removed.test.ts", "test-create-require-budget"],
    ["test/e2e/live/removed.test.ts", "vitest-project-overlap"],
    ["nemoclaw/src/example.spec.ts", "test-title-style"],
    ["test/e2e/fixtures/example.ts", "e2e-assertion-census"],
    [".github/actions/ci-static-checks/action.yaml", "growth-guardrails-workflow-boundary"],
  ])("selects the owning check for %s", (file, name) => {
    expect(selectChecks(CHECKS, [file]).map((check) => check.name)).toContain(name);
  });

  it("reports the duration and failure before stopping the batch", () => {
    const spawn = vi.fn().mockReturnValue({ status: 2 });
    const report = vi.fn();
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(35);
    const exit = vi.fn((code?: number): never => {
      throw new Error(`exit ${code}`);
    });
    expect(() =>
      runChecks({ checks: [sampleCheck, sampleCheck], spawn, report, now, exit }),
    ).toThrow("exit 2");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith("sample: failed (25 ms)");
  });

  it("runs the Pi qualification receipt refresh check", () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnSyncOptions) =>
      successfulSpawn(),
    );

    runChecks({ platform: "linux", spawn });

    expect(spawn).toHaveBeenCalledWith(
      path.resolve("node_modules/.bin", process.platform === "win32" ? "tsx.cmd" : "tsx"),
      ["scripts/checks/pi-qualification-receipt-refresh.mts"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("runs Windows command shims through cmd.exe", () => {
    expect(
      buildCheckSpawnInvocation(sampleCheck, "win32", {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "tsx.cmd", "scripts/checks/sample.mts"],
    });
  });

  it("uses cmd.exe when ComSpec is unavailable on Windows", () => {
    expect(buildCheckSpawnInvocation(sampleCheck, "win32", {})).toMatchObject({
      command: "cmd.exe",
    });
  });

  it("keeps POSIX runner execution direct", () => {
    expect(buildCheckSpawnInvocation(sampleCheck, "linux")).toEqual({
      command: "tsx.cmd",
      args: ["scripts/checks/sample.mts"],
    });
  });

  it("uses the Windows shim invocation when running checks", () => {
    const calls: SpawnSyncOptions[] = [];
    const spawn = vi.fn((_command: string, _args: string[], options: SpawnSyncOptions) => {
      calls.push(options);
      return successfulSpawn();
    });

    runChecks({
      checks: [sampleCheck],
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "tsx.cmd", "scripts/checks/sample.mts"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(calls[0]?.shell).toBeUndefined();
  });

  it("uses direct execution when running checks on POSIX", () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnSyncOptions) =>
      successfulSpawn(),
    );

    runChecks({ checks: [sampleCheck], platform: "linux", spawn });

    expect(spawn).toHaveBeenCalledWith(
      "tsx.cmd",
      ["scripts/checks/sample.mts"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("exits with one when a check has no status", () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnSyncOptions) => ({
      status: null,
      error: new Error("spawn failed"),
    }));
    const exit = vi.fn((code?: number): never => {
      throw new Error(`exit ${code}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => runChecks({ checks: [sampleCheck], platform: "linux", spawn, exit })).toThrow(
      "exit 1",
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith("Check failed: sample");
    expect(error).toHaveBeenCalledWith("spawn failed");
    error.mockRestore();
  });

  it("exits with the check status code on failure", () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnSyncOptions) => ({
      status: 2,
    }));
    const exit = vi.fn((code?: number): never => {
      throw new Error(`exit ${code}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => runChecks({ checks: [sampleCheck], platform: "linux", spawn, exit })).toThrow(
      "exit 2",
    );
    expect(exit).toHaveBeenCalledWith(2);
    expect(error).toHaveBeenCalledWith("Check failed: sample");
    expect(error).not.toHaveBeenCalledWith("spawn failed");
    error.mockRestore();
  });
});
