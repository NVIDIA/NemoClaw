// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  buildCliDistCoverageArgs,
  isDirectExecution,
  resolveLocalVitestBin,
  runCliDistCoverage,
} from "../scripts/coverage-cli-dist-signal";

describe("coverage-cli-dist-signal", () => {
  it("builds Vitest args that include dist files and remappable source files", () => {
    const args = buildCliDistCoverageArgs();

    expect(args).toEqual(
      expect.arrayContaining([
        "run",
        "--project",
        "cli",
        "--coverage",
        "--coverage.provider=v8",
        "--coverage.reportOnFailure",
        "--coverage.include=src/**/*.ts",
        "--coverage.include=dist/**/*.js",
        "--coverage.include=bin/**/*.js",
        "--coverage.exclude=nemoclaw/**",
      ]),
    );
    expect(args).toContain("--coverage.reportsDirectory=coverage/cli-dist-signal");
  });

  it("appends user-supplied filters after the coverage configuration", () => {
    const args = buildCliDistCoverageArgs(["src/lib/actions/sandbox/status-flow.test.ts"]);

    expect(args.at(-1)).toBe("src/lib/actions/sandbox/status-flow.test.ts");
  });

  it("resolves the repository-local Vitest executable instead of shelling through npx", () => {
    expect(resolveLocalVitestBin("/repo")).toBe(
      path.join(
        "/repo",
        "node_modules",
        ".bin",
        process.platform === "win32" ? "vitest.cmd" : "vitest",
      ),
    );
  });

  it("runs the local Vitest binary and returns its exit status", () => {
    const spawn = vi.fn(() => ({ status: 7, signal: null, error: undefined }));

    expect(
      runCliDistCoverage(["test/coverage-cli-dist-signal.test.ts"], {
        spawn,
        repoRoot: "/repo",
        env: { TEST_ENV: "1" } as NodeJS.ProcessEnv,
      }),
    ).toBe(7);

    expect(spawn).toHaveBeenCalledWith(
      resolveLocalVitestBin("/repo"),
      expect.arrayContaining(["run", "test/coverage-cli-dist-signal.test.ts"]),
      { stdio: "inherit", env: { TEST_ENV: "1" } },
    );
  });

  it("throws spawn errors instead of reporting success", () => {
    const error = new Error("spawn failed");
    const spawn = vi.fn(() => ({ status: null, signal: null, error }));

    expect(() => runCliDistCoverage([], { spawn, repoRoot: "/repo" })).toThrow("spawn failed");
  });

  it("propagates child-process signals to the current process", () => {
    const spawn = vi.fn(() => ({
      status: null,
      signal: "SIGTERM" as NodeJS.Signals,
      error: undefined,
    }));
    const kill = vi.fn();

    expect(runCliDistCoverage([], { spawn, kill, repoRoot: "/repo" })).toBeNull();

    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("detects direct execution with normalized filesystem paths", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "coverage-cli-dist-signal.ts");

    expect(isDirectExecution(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
    expect(
      isDirectExecution(pathToFileURL(scriptPath).href, "scripts/coverage-cli-dist-signal.ts"),
    ).toBe(true);
    expect(isDirectExecution(pathToFileURL(scriptPath).href, undefined)).toBe(false);
  });
});
