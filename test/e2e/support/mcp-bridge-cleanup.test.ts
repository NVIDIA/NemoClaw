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

  it("uses administrator deletion when safe gateway initialization refuses cleanup", async () => {
    const calls: string[] = [];
    const host = cleanupClient("host", calls);
    const sandbox = cleanupClient("openshell", calls);
    const cleanup = new CleanupRegistry();
    host.cleanupSandbox.mockRejectedValueOnce(new Error("retained identity requires recovery"));

    await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, "e2e-mcp-bridge");

    expect(calls).toEqual([
      "openshell:precleanup-delete-openshell-sandbox",
      "host:precleanup-destroy-sandbox",
    ]);
  });
});
