// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigTarget } from "./config";
import { seedHermesDashboardConfig } from "./config";

interface CaptureResult {
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

const TARGET: AgentConfigTarget = {
  agentName: "hermes",
  configPath: "/sandbox/.hermes/config.yaml",
  configDir: "/sandbox/.hermes",
  format: "yaml",
  configFile: "config.yaml",
};
const PYTHON = "/opt/hermes/.venv/bin/python3";
const SEEDER = "/usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py";
const DASHBOARD_CONFIG = "/sandbox/.hermes/dashboard-home/config.yaml";
const capture = vi.fn<(binary: string, args: string[], options: unknown) => CaptureResult>();
const reportFailure = vi.fn<(stage: "python" | "inspection" | "seed", detail: string) => void>();

function result(overrides: Partial<CaptureResult> = {}): CaptureResult {
  return { status: 0, output: "", stdout: "", stderr: "", signal: null, ...overrides };
}

function sandboxCommand(args: string[]): string[] {
  const separator = args.indexOf("--");
  expect(separator).toBe(4);
  return args.slice(separator + 1);
}

function successfulSeed(configPath = DASHBOARD_CONFIG): CaptureResult {
  return result({ stderr: `[dashboard] seeded model routing into ${configPath}\n` });
}

function mockReseedFlow(options: { inspection?: CaptureResult; seed?: CaptureResult } = {}): void {
  capture
    .mockReturnValueOnce(result())
    .mockReturnValueOnce(options.inspection ?? result())
    .mockReturnValueOnce(options.seed ?? successfulSeed());
}

describe("seedHermesDashboardConfig", () => {
  beforeEach(() => {
    capture.mockReset();
    reportFailure.mockReset();
  });

  const deps = {
    getOpenshellBinary: () => "/host/OpenShell binary;still-one-argv",
    captureOpenshellCommand: capture,
    reportFailure,
  };

  it("passes adversarial paths as discrete argv without invoking a shell (#6893)", () => {
    mockReseedFlow({
      seed: successfulSeed("/sandbox/Hermes home;$(touch dir-pwned)/dashboard-home/config.yaml"),
    });
    const target: AgentConfigTarget = {
      ...TARGET,
      configPath: "/sandbox/Hermes config;$(touch source-pwned)/config'quote.yaml",
      configDir: "/sandbox/Hermes home;$(touch dir-pwned)",
    };

    expect(seedHermesDashboardConfig("hermes name;$(touch sandbox-pwned)", target, deps)).toBe(
      "converged",
    );

    expect(capture).toHaveBeenCalledTimes(3);
    for (const [binary, args, options] of capture.mock.calls) {
      expect(binary).toBe("/host/OpenShell binary;still-one-argv");
      expect(args.slice(0, 5)).toEqual([
        "sandbox",
        "exec",
        "--name",
        "hermes name;$(touch sandbox-pwned)",
        "--",
      ]);
      expect(sandboxCommand(args)[0]).not.toMatch(/^(?:ba)?sh$/);
      for (const arg of args) expect(arg).not.toMatch(/[\r\n]/u);
      expect(options).toEqual({
        ignoreError: true,
        includeStreams: true,
        maxBuffer: 17 * 1024 * 1024,
        timeout: 30_000,
      });
    }
    expect(sandboxCommand(capture.mock.calls[0][1])).toEqual([PYTHON, "-c", ""]);
    const inspectionCommand = sandboxCommand(capture.mock.calls[1][1]);
    expect(inspectionCommand[0]).toBe(PYTHON);
    expect(inspectionCommand[1]).toBe("-c");
    expect(inspectionCommand[2]).toContain("os.lstat(sys.argv[1])");
    expect(inspectionCommand[2]).toContain("except FileNotFoundError:");
    expect(inspectionCommand[2]).toContain("stat.S_ISDIR(mode)");
    expect(inspectionCommand.at(-1)).toBe("/sandbox/Hermes home;$(touch dir-pwned)/dashboard-home");
    expect(sandboxCommand(capture.mock.calls[2][1])).toEqual([
      PYTHON,
      SEEDER,
      "/sandbox/Hermes config;$(touch source-pwned)/config'quote.yaml",
      "/sandbox/Hermes home;$(touch dir-pwned)/dashboard-home/config.yaml",
      "/sandbox/Hermes home;$(touch dir-pwned)/.env",
      "/sandbox/Hermes home;$(touch dir-pwned)/dashboard-home/.env",
    ]);
  });

  it("returns absent only when the path inspection reports it missing (#6893)", () => {
    mockReseedFlow({ inspection: result({ status: 3, stderr: "missing" }) });

    expect(seedHermesDashboardConfig("hermes", TARGET, deps)).toBe("absent");
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a regular file", result({ status: 2, stderr: "not a directory" })],
    ["a broken symlink", result({ status: 2, stderr: "symlink" })],
    ["an inspection error", result({ status: 2, stderr: "permission denied" })],
  ])("fails closed when dashboard-home is %s (#6893)", (_case, inspection) => {
    mockReseedFlow({ inspection });

    expect(seedHermesDashboardConfig("hermes", TARGET, deps)).toBe("failed");
    expect(capture).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledWith(
      "inspection",
      expect.stringMatching(/^status=2 detail=/u),
    );
  });

  it.each([
    ["a nonzero exit", result({ status: 1, output: "seed failed", stderr: "write denied" })],
    [
      "a captured execution error",
      result({ status: null, output: "", error: new Error("spawn failed") }),
    ],
    ["a signal", result({ status: null, output: "", signal: "SIGTERM" })],
  ])("maps %s from the seeder to failed while capturing both streams (#6893)", (_case, seed) => {
    mockReseedFlow({ seed });

    expect(seedHermesDashboardConfig("hermes", TARGET, deps)).toBe("failed");
    expect(capture).toHaveBeenCalledTimes(3);
    expect(capture.mock.calls[2][2]).toMatchObject({ includeStreams: true });
    expect(reportFailure).toHaveBeenCalledWith("seed", expect.stringMatching(/^status=/u));
  });

  it.each([
    [
      "PyYAML is unavailable",
      "[dashboard] PyYAML unavailable (No module named yaml); skipping model seed",
    ],
    [
      "the gateway config is missing",
      `[dashboard] gateway config ${TARGET.configPath} missing; skipping model seed`,
    ],
    [
      "the gateway config is unreadable",
      `[dashboard] gateway config ${TARGET.configPath} unreadable (permission denied); skipping model seed`,
    ],
    [
      "the gateway config has no model routing",
      "[dashboard] gateway config has no model routing; nothing to seed",
    ],
  ])("fails closed when %s despite a zero exit (#6893)", (_case, stderr) => {
    mockReseedFlow({ seed: result({ stderr: `${stderr}\n` }) });

    expect(seedHermesDashboardConfig("hermes", TARGET, deps)).toBe("failed");
    expect(capture).toHaveBeenCalledTimes(3);
    expect(reportFailure).toHaveBeenCalledWith(
      "seed",
      expect.stringContaining(`status=0 detail=${stderr}`),
    );
  });

  it("requires the success marker for the requested dashboard config path (#6893)", () => {
    mockReseedFlow({ seed: successfulSeed("/sandbox/.hermes/other/config.yaml") });

    expect(seedHermesDashboardConfig("hermes", TARGET, deps)).toBe("failed");
    expect(reportFailure).toHaveBeenCalledWith("seed", expect.stringMatching(/^status=0 detail=/u));
  });

  it("fails when none of the fixed trusted Python candidates can run (#6893)", () => {
    capture.mockReturnValue(result({ status: 127, stderr: "not found" }));

    expect(seedHermesDashboardConfig("hermes", TARGET, deps)).toBe("failed");
    expect(capture).toHaveBeenCalledTimes(3);
    expect(capture.mock.calls.map((call) => sandboxCommand(call[1])[0])).toEqual([
      "/opt/hermes/.venv/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
    ]);
    expect(reportFailure).toHaveBeenCalledWith("python", "status=127 detail=not found");
  });

  it("fully redacts and bounds captured seeder diagnostics (#6893)", () => {
    mockReseedFlow({
      seed: result({
        status: 1,
        stderr: `Authorization: Bearer nvapi-secret-value ${"x".repeat(1_000)}`,
      }),
    });

    expect(seedHermesDashboardConfig("hermes", TARGET, deps)).toBe("failed");
    const [, detail] = reportFailure.mock.calls[0];
    expect(detail).toContain("Bearer <REDACTED>");
    expect(detail).not.toContain("nvapi-secret-value");
    expect(detail.length).toBeLessThanOrEqual(820);
  });
});
