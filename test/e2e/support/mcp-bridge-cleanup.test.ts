// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import { prepareOwnedSandboxForOnboard } from "../live/mcp-bridge-cleanup.ts";

function cleanupClient(owner: string, calls: string[]) {
  const cleanupSandbox = vi.fn(async (_name: string, options: ShellProbeRunOptions = {}) => {
    calls.push(`${owner}:${options.artifactName}`);
  });
  return {
    command: vi.fn(async (_command: string, _args: string[], options: ShellProbeRunOptions) => {
      calls.push(`${owner}:${options.artifactName}`);
      return {
        command: [],
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        artifacts: { stdout: "", stderr: "", result: "" },
      };
    }),
    cleanupSandbox,
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

    await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, "e2e-mcp-bridge");
    expect(calls).toEqual([
      "host:precleanup-initialize-gateway",
      "host:precleanup-best-effort-destroy",
      "openshell:precleanup-delete-openshell-sandbox",
      "host:precleanup-destroy-sandbox",
    ]);
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
      "host:precleanup-best-effort-destroy",
      "openshell:precleanup-delete-openshell-sandbox",
      "host:precleanup-destroy-sandbox",
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

    await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, "e2e-mcp-bridge");
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

  it("uses administrator deletion when initialized gateway cleanup refuses retained state", async () => {
    const calls: string[] = [];
    const host = cleanupClient("host", calls);
    const sandbox = cleanupClient("openshell", calls);
    const cleanup = new CleanupRegistry();
    host.cleanupSandbox.mockRejectedValueOnce(new Error("retained identity requires recovery"));

    await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, "e2e-mcp-bridge");

    expect(calls).toEqual([
      "host:precleanup-initialize-gateway",
      "openshell:precleanup-delete-openshell-sandbox",
      "host:precleanup-destroy-sandbox",
    ]);
  });
  it("stops precleanup after startup failure and retains strict teardown", async () => {
    const calls: string[] = [];
    const host = cleanupClient("host", calls);
    const sandbox = cleanupClient("openshell", calls);
    const cleanup = new CleanupRegistry();
    host.command.mockRejectedValueOnce(new Error("gateway startup refused"));
    await expect(
      prepareOwnedSandboxForOnboard(host, sandbox, cleanup, "e2e-mcp-bridge"),
    ).rejects.toThrow("gateway startup refused");
    expect(sandbox.cleanupSandbox).not.toHaveBeenCalled();
    sandbox.cleanupSandbox.mockRejectedValueOnce(new Error("Unknown gateway 'nemoclaw'"));
    const result = await cleanup.runAll();
    expect(result.failures).toEqual([
      {
        name: "delete owned OpenShell sandbox e2e-mcp-bridge",
        message: "Unknown gateway 'nemoclaw'",
      },
    ]);
    expect(host.cleanupSandbox).toHaveBeenCalledTimes(1);
  });
});
