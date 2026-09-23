// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import { prepareOwnedSandboxForOnboard } from "../fixtures/owned-sandbox-cleanup.ts";

const state = vi.hoisted(() => ({ registered: false }));
vi.mock("../../../src/lib/state/registry.ts", () => ({
  getSandbox: () => (state.registered ? { name: "e2e-mcp-bridge" } : null),
}));

function fixture() {
  const calls: string[] = [];
  const host = {
    command: vi.fn(async () => {
      throw new Error("cleanup must not start a gateway");
    }),
    cleanupSandbox: vi.fn(async (_name: string, options: ShellProbeRunOptions = {}) => {
      calls.push(`cli:${options.artifactName}`);
    }),
  };
  const sandbox = new SandboxClient({ run: vi.fn() });
  const response = (patch: Partial<ShellProbeResult> = {}): ShellProbeResult => ({
    command: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
    ...patch,
  });
  const presentGateway = {
    stdout: JSON.stringify({ gateway: process.env.OPENSHELL_GATEWAY?.trim() || "nemoclaw" }),
  };
  const gateway = {
    response: {
      exitCode: 1,
      stderr: "No gateway configured.\n│ Register a gateway with: openshell gateway add <endpoint>",
    } as Partial<ShellProbeResult>,
  };
  const openshell = vi
    .spyOn(sandbox, "openshell")
    .mockImplementation(async (args = [], options) => {
      calls.push(args.slice(0, 2).join(" "));
      expect(options?.env?.OPENSHELL_GATEWAY).toBe(
        process.env.OPENSHELL_GATEWAY?.trim() || "nemoclaw",
      );
      const results: Record<string, ShellProbeResult> = {
        gateway: response(gateway.response),
        sandbox: response(),
      };
      expect(results).toHaveProperty(args[0]);
      return results[args[0]]!;
    });
  const cleanup = new CleanupRegistry();
  const prepare = () => prepareOwnedSandboxForOnboard(host, sandbox, cleanup, "e2e-mcp-bridge");
  return { calls, host, sandbox, openshell, gateway, presentGateway, cleanup, prepare };
}

describe("owned-sandbox cleanup", () => {
  beforeEach(() => {
    state.registered = false;
  });

  it("does not start a gateway or run CLI recovery when fresh resources are absent", async () => {
    const f = fixture();
    await f.prepare();
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.calls).toEqual(["gateway info", "gateway info"]);
    expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
    expect(f.host.command).not.toHaveBeenCalled();
  });

  it("deletes orphaned OpenShell resources even without a NemoClaw registry entry", async () => {
    const f = fixture();
    f.gateway.response = f.presentGateway;
    await f.prepare();
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.calls).toEqual(["gateway info", "sandbox delete", "gateway info", "sandbox delete"]);
    expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
  });

  it("deletes administrator state before registered CLI reconciliation in both phases", async () => {
    const f = fixture();
    f.gateway.response = f.presentGateway;
    state.registered = true;
    await f.prepare();
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.calls).toEqual([
      "gateway info",
      "sandbox delete",
      "cli:precleanup-destroy-sandbox",
      "gateway info",
      "sandbox delete",
      "cli:cleanup-destroy-sandbox",
    ]);
  });

  it("checks registration at teardown so resources acquired after preparation are cleaned", async () => {
    const f = fixture();
    await f.prepare();
    state.registered = true;
    f.gateway.response = f.presentGateway;
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.calls).toEqual([
      "gateway info",
      "gateway info",
      "sandbox delete",
      "cli:cleanup-destroy-sandbox",
    ]);
  });

  it("does not recover a CLI entry that disappeared before teardown", async () => {
    const f = fixture();
    f.gateway.response = f.presentGateway;
    state.registered = true;
    await f.prepare();
    state.registered = false;
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.host.cleanupSandbox).toHaveBeenCalledTimes(1);
  });

  it.each([
    { exitCode: 1, stderr: "permission denied" },
    { exitCode: null, timedOut: true, stderr: "No gateway configured." },
    { stdout: "invalid json" },
  ])("fails closed on uncertain gateway evidence %j", async (failure) => {
    const f = fixture();
    f.gateway.response = failure;
    await expect(f.prepare()).rejects.toThrow();
    const result = await f.cleanup.runAll();
    expect(result.failures).toHaveLength(1);
    expect(f.calls).toEqual(["gateway info", "gateway info"]);
    expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
  });

  it("records administrator cleanup failure while still reconciling registered CLI state", async () => {
    const f = fixture();
    f.gateway.response = f.presentGateway;
    state.registered = true;
    await f.prepare();
    f.openshell.mockRejectedValueOnce(new Error("openshell cleanup failed"));
    expect((await f.cleanup.runAll()).failures).toEqual([
      {
        name: "delete owned OpenShell sandbox e2e-mcp-bridge",
        message: "openshell cleanup failed",
      },
    ]);
    expect(f.calls.at(-1)).toBe("cli:cleanup-destroy-sandbox");
  });
});
