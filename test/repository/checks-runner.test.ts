// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CHECKS, runChecks, selectChecks } from "../../scripts/checks/run.mts";

import { validationFixture, writeFixture } from "./validation-fixture";

const sampleCheck = {
  name: "sample",
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
    "nemoclaw/vitest.project.ts",
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

    runChecks({ spawn });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve("tsx/cli")),
        "scripts/checks/pi-qualification-receipt-refresh.mts",
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("starts checks with literal paths and arguments without a command shell", () => {
    const root = validationFixture();
    const checkout = path.join(root, "checkout & spaces");
    try {
      writeFixture(
        checkout,
        "scripts/checks/probe.mts",
        'import {writeFileSync} from "node:fs"; const value: string = process.argv[2]; writeFileSync("observed.json", JSON.stringify(value));\n',
      );
      const runner = path.join(checkout, "scripts/checks/run.mts");
      copyFileSync(path.resolve("scripts/checks/run.mts"), runner);
      symlinkSync(path.resolve("node_modules"), path.join(checkout, "node_modules"), "junction");
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import {runChecks} from ${JSON.stringify(pathToFileURL(runner).href)}; runChecks({checks:[{name:"probe",args:["scripts/checks/probe.mts","literal & argument"]}]});`,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, ComSpec: "must-not-run" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(path.join(checkout, "observed.json"), "utf8"))).toBe(
        "literal & argument",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

    expect(() => runChecks({ checks: [sampleCheck], spawn, exit })).toThrow("exit 1");
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

    expect(() => runChecks({ checks: [sampleCheck], spawn, exit })).toThrow("exit 2");
    expect(exit).toHaveBeenCalledWith(2);
    expect(error).toHaveBeenCalledWith("Check failed: sample");
    expect(error).not.toHaveBeenCalledWith("spawn failed");
    error.mockRestore();
  });
});
