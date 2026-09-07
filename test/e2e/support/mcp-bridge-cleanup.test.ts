// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import { prepareOwnedSandboxForOnboard } from "../live/mcp-bridge-cleanup.ts";

function cleanupClient(owner: string, calls: string[]) {
  const cleanupSandbox = vi.fn(async (_name: string, options: ShellProbeRunOptions = {}) => {
    calls.push(`${owner}:${options.artifactName}`);
  });
  return {
    cleanupSandbox,
    openshell: vi.fn(
      async (_args: string[], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> => {
        calls.push(`${owner}:${options.artifactName}`);
        return {
          command: ["openshell", "sandbox", "get"],
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "NotFound: sandbox not found",
          artifacts: { stdout: "", stderr: "", result: "" },
        };
      },
    ),
    bestEffortCleanupSandbox: vi.fn(async (name: string, options: ShellProbeRunOptions = {}) => {
      try {
        await cleanupSandbox(name, options);
      } catch {
        // Match HostCliClient: the administrator fallback must still run.
      }
    }),
  };
}

describe("MCP bridge owned-sandbox cleanup", () => {
  it("initializes the gateway before administrator deletion and final reconciliation", async () => {
    const calls: string[] = [];
    const host = cleanupClient("host", calls);
    const sandbox = cleanupClient("openshell", calls);
    const cleanup = new CleanupRegistry();
    const artifacts = { writeJson: vi.fn().mockResolvedValue("/tmp/retry.json") };

    await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, artifacts, "e2e-mcp-bridge");
    expect(calls).toEqual([
      "host:precleanup-initialize-gateway",
      "openshell:precleanup-delete-openshell-sandbox",
      "host:precleanup-destroy-sandbox",
      "openshell:precleanup-wait-sandbox-absent-1",
    ]);
    expect(artifacts.writeJson).toHaveBeenCalledWith(
      "precleanup-sandbox-absence-retry.json",
      expect.objectContaining({ outcome: "passed-first-attempt" }),
    );
    expect(sandbox.cleanupSandbox).toHaveBeenNthCalledWith(
      1,
      "e2e-mcp-bridge",
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: expect.any(String),
          OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY?.trim() || "nemoclaw",
        }),
      }),
    );

    const result = await cleanup.runAll();

    expect(result.failures).toEqual([]);
    expect(calls).toEqual([
      "host:precleanup-initialize-gateway",
      "openshell:precleanup-delete-openshell-sandbox",
      "host:precleanup-destroy-sandbox",
      "openshell:precleanup-wait-sandbox-absent-1",
      "openshell:cleanup-delete-openshell-sandbox",
      "host:cleanup-destroy-sandbox",
    ]);
    expect(sandbox.cleanupSandbox).toHaveBeenNthCalledWith(
      2,
      "e2e-mcp-bridge",
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: expect.any(String),
          OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY?.trim() || "nemoclaw",
        }),
      }),
    );
  });

  it("still attempts NemoClaw reconciliation when administrator deletion fails", async () => {
    const calls: string[] = [];
    const host = cleanupClient("host", calls);
    const sandbox = cleanupClient("openshell", calls);
    const cleanup = new CleanupRegistry();
    const artifacts = { writeJson: vi.fn().mockResolvedValue("/tmp/retry.json") };

    await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, artifacts, "e2e-mcp-bridge");
    sandbox.cleanupSandbox.mockRejectedValueOnce(new Error("openshell cleanup failed"));
    const result = await cleanup.runAll();

    expect(result.failures).toEqual([
      {
        name: "delete owned OpenShell sandbox e2e-mcp-bridge",
        message: "openshell cleanup failed",
      },
    ]);
    expect(calls.at(-1)).toBe("host:cleanup-destroy-sandbox");
  });

  it("uses administrator deletion when safe gateway initialization refuses cleanup", async () => {
    const calls: string[] = [];
    const host = cleanupClient("host", calls);
    const sandbox = cleanupClient("openshell", calls);
    const cleanup = new CleanupRegistry();
    const artifacts = { writeJson: vi.fn().mockResolvedValue("/tmp/retry.json") };
    host.cleanupSandbox.mockRejectedValueOnce(new Error("retained identity requires recovery"));

    await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, artifacts, "e2e-mcp-bridge");

    expect(calls).toEqual([
      "openshell:precleanup-delete-openshell-sandbox",
      "host:precleanup-destroy-sandbox",
      "openshell:precleanup-wait-sandbox-absent-1",
    ]);
  });

  it("waits for asynchronous administrator deletion to converge before onboarding", async () => {
    const calls: string[] = [];
    const host = cleanupClient("host", calls);
    const sandbox = cleanupClient("openshell", calls);
    const cleanup = new CleanupRegistry();
    const artifacts = { writeJson: vi.fn().mockResolvedValue("/tmp/retry.json") };
    const sleep = vi.fn().mockResolvedValue(undefined);
    sandbox.openshell
      .mockResolvedValueOnce({
        command: ["openshell", "sandbox", "get"],
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "phase: Deleting",
        stderr: "",
        artifacts: { stdout: "", stderr: "", result: "" },
      })
      .mockResolvedValueOnce({
        command: ["openshell", "sandbox", "get"],
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "NotFound: sandbox not found",
        artifacts: { stdout: "", stderr: "", result: "" },
      });

    await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, artifacts, "e2e-mcp-bridge", {
      artifactPrefix: "reconcile",
      registerCleanup: false,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(sandbox.openshell).toHaveBeenCalledTimes(2);
    expect(artifacts.writeJson).toHaveBeenCalledWith(
      "reconcile-sandbox-absence-retry.json",
      expect.objectContaining({
        outcome: "passed-after-retry",
        attempts: [
          expect.objectContaining({
            attempt: 1,
            failureClass: "transient-external",
            retryScheduled: true,
          }),
          expect.objectContaining({ attempt: 2, outcome: "passed", retryScheduled: false }),
        ],
      }),
    );
    await expect(cleanup.runAll()).resolves.toEqual({ failures: [], passed: [] });
  });

  it("stops absence polling on an unexpected OpenShell error", async () => {
    const calls: string[] = [];
    const host = cleanupClient("host", calls);
    const sandbox = cleanupClient("openshell", calls);
    const cleanup = new CleanupRegistry();
    const artifacts = { writeJson: vi.fn().mockResolvedValue("/tmp/retry.json") };
    const sleep = vi.fn().mockResolvedValue(undefined);
    sandbox.openshell.mockResolvedValueOnce({
      command: ["openshell", "sandbox", "get"],
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "gateway unavailable",
      artifacts: { stdout: "", stderr: "", result: "" },
    });

    await expect(
      prepareOwnedSandboxForOnboard(host, sandbox, cleanup, artifacts, "e2e-mcp-bridge", {
        sleep,
      }),
    ).rejects.toThrow("Could not confirm owned sandbox");
    expect(sandbox.openshell).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(artifacts.writeJson).toHaveBeenCalledWith(
      "precleanup-sandbox-absence-retry.json",
      expect.objectContaining({ outcome: "failed-no-retry" }),
    );
  });
});
