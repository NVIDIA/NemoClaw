// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NemoClawState } from "../blueprint/state.js";
import type { NemoClawConfig } from "../index.js";
import { captureLogger, mockSpawnProc } from "../test-helpers.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFn = vi.fn();
  // Attach a custom promisify that mirrors the real exec behaviour:
  // the raw callback uses (err, stdout, stderr); promisify folds them
  // into { stdout, stderr } just like the real Node implementation.
  Object.defineProperty(execFn, promisify.custom, {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        (execFn as Function)(...args, (err: Error | null, stdout: string, stderr: string) => {
          if (err) {
            Object.assign(err, { stdout, stderr });
            reject(err);
          } else {
            resolve({ stdout, stderr });
          }
        });
      }),
  });
  return { exec: execFn, spawn: vi.fn() };
});

vi.mock("../blueprint/state.js", () => ({
  loadState: vi.fn(),
}));

// Import after mocks are set up
const { exec, spawn } = await import("node:child_process");
const { loadState } = await import("../blueprint/state.js");
const { cliLogs } = await import("./logs.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blankState(): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: new Date().toISOString(),
  };
}

const defaultConfig: NemoClawConfig = {
  blueprintVersion: "latest",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  sandboxName: "openclaw",
  inferenceProvider: "nvidia",
};

/**
 * Make the exec mock resolve with the given stdout, or reject if error is set.
 * Routes by command substring.
 *
 * Uses the real Node `exec` callback signature `(err, stdout, stderr)` so that
 * `util.promisify(exec)` — which is what production code calls — receives
 * the three positional arguments it expects before folding them into
 * `{ stdout, stderr }`.
 */
function mockExec(responses: Record<string, string | Error>): void {
  vi.mocked(exec).mockImplementation(((
    cmd: string,
    _opts: unknown,
    callback?: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    for (const [substring, response] of Object.entries(responses)) {
      if (cmd.includes(substring)) {
        if (response instanceof Error) {
          callback?.(response, "", response.message);
        } else {
          callback?.(null, response, "");
        }
        return;
      }
    }
    callback?.(new Error(`command not found: ${cmd}`), "", "");
  }) as typeof exec);
}

/** Create a mock spawn that emits events. */
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadState).mockReturnValue(blankState());
  mockExec({});
});

describe("cliLogs", () => {
  describe("sandbox not running", () => {
    it("shows 'not running' message when sandbox is not active", async () => {
      mockExec({
        "sandbox get": new Error("not found"),
      });

      const { lines, logger } = captureLogger();
      await cliLogs({
        follow: false,
        lines: 50,
        logger,
        pluginConfig: defaultConfig,
      });

      const output = lines.join("\n");
      expect(output).toContain("not running");
      expect(output).toContain("No live logs available");
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe("sandbox running", () => {
    it("spawns openshell with correct args for basic log viewing", async () => {
      mockExec({
        "sandbox get": JSON.stringify({ state: "running" }),
      });
      mockSpawnProc(vi.mocked(spawn), 0);

      const { logger } = captureLogger();
      await cliLogs({
        follow: false,
        lines: 50,
        logger,
        pluginConfig: defaultConfig,
      });

      expect(spawn).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "connect", "openclaw", "--", "tail", "-n", "50",
         "/tmp/nemoclaw.log", "/tmp/openclaw.log"],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
    });

    it("adds -f flag when --follow is set", async () => {
      mockExec({
        "sandbox get": JSON.stringify({ state: "running" }),
      });
      mockSpawnProc(vi.mocked(spawn), 0);

      const { logger } = captureLogger();
      await cliLogs({
        follow: true,
        lines: 100,
        logger,
        pluginConfig: defaultConfig,
      });

      expect(spawn).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "connect", "openclaw", "--", "tail", "-f", "-n", "100",
         "/tmp/nemoclaw.log", "/tmp/openclaw.log"],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
    });

    it("sets -n value from --lines flag", async () => {
      mockExec({
        "sandbox get": JSON.stringify({ state: "running" }),
      });
      mockSpawnProc(vi.mocked(spawn), 0);

      const { logger } = captureLogger();
      await cliLogs({
        follow: false,
        lines: 200,
        logger,
        pluginConfig: defaultConfig,
      });

      expect(spawn).toHaveBeenCalledWith(
        "openshell",
        expect.arrayContaining(["-n", "200"]),
        expect.anything(),
      );
    });
  });

  describe("--run-id / state run info", () => {
    it("shows run info from state when runId is provided", async () => {
      vi.mocked(loadState).mockReturnValue({
        ...blankState(),
        lastRunId: "run-abc123",
        lastAction: "migrate",
      });
      mockExec({
        "sandbox get": new Error("not found"),
      });

      const { lines, logger } = captureLogger();
      await cliLogs({
        follow: false,
        lines: 50,
        runId: "run-custom-id",
        logger,
        pluginConfig: defaultConfig,
      });

      const output = lines.join("\n");
      expect(output).toContain("Blueprint run: run-custom-id");
      expect(output).toContain("Action: migrate");
    });

    it("shows last run from state when no runId is provided", async () => {
      vi.mocked(loadState).mockReturnValue({
        ...blankState(),
        lastRunId: "run-from-state",
        lastAction: "deploy",
      });
      mockExec({
        "sandbox get": new Error("not found"),
      });

      const { lines, logger } = captureLogger();
      await cliLogs({
        follow: false,
        lines: 50,
        logger,
        pluginConfig: defaultConfig,
      });

      const output = lines.join("\n");
      expect(output).toContain("Blueprint run: run-from-state");
      expect(output).toContain("Action: deploy");
    });

    it("does not show run info when no runId and state has none", async () => {
      mockExec({
        "sandbox get": new Error("not found"),
      });

      const { lines, logger } = captureLogger();
      await cliLogs({
        follow: false,
        lines: 50,
        logger,
        pluginConfig: defaultConfig,
      });

      const output = lines.join("\n");
      expect(output).not.toContain("Blueprint run:");
    });
  });

  describe("sandbox name resolution", () => {
    it("uses state.sandboxName when available", async () => {
      vi.mocked(loadState).mockReturnValue({
        ...blankState(),
        sandboxName: "my-sandbox",
      });
      mockExec({
        "sandbox get": JSON.stringify({ state: "running" }),
      });
      mockSpawnProc(vi.mocked(spawn), 0);

      const { logger } = captureLogger();
      await cliLogs({
        follow: false,
        lines: 50,
        logger,
        pluginConfig: defaultConfig,
      });

      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining("my-sandbox"),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("spawn error handling", () => {
    it("logs error when spawn emits an error", async () => {
      mockExec({
        "sandbox get": JSON.stringify({ state: "running" }),
      });
      mockSpawnProc(vi.mocked(spawn), null, new Error("ENOENT: openshell not found"));

      const { lines, logger } = captureLogger();
      await cliLogs({
        follow: false,
        lines: 50,
        logger,
        pluginConfig: defaultConfig,
      });

      const output = lines.join("\n");
      expect(output).toContain("Failed to stream logs");
      expect(output).toContain("ENOENT");
    });
  });
});
