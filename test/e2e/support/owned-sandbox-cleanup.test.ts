// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import { prepareOwnedSandboxForOnboard } from "../fixtures/owned-sandbox-cleanup.ts";

const state = vi.hoisted(() => ({
  registered: false,
  gatewayPort: undefined as number | undefined,
}));
vi.mock("../../../src/lib/state/registry.ts", () => ({
  getSandbox: () =>
    state.registered ? { name: "e2e-mcp-bridge", gatewayPort: state.gatewayPort } : null,
}));

function fixture() {
  const calls: string[] = [];
  const host = {
    command: vi.fn(
      async (
        _command: string,
        _argv: string[],
        _options: ShellProbeRunOptions,
      ): Promise<ShellProbeResult> => {
        throw new Error("cleanup must not start a gateway");
      },
    ),
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
    stdout: JSON.stringify({ gateway: "nemoclaw" }),
  };
  const gateway = {
    name: "nemoclaw",
    response: {
      exitCode: 1,
      stderr: "No gateway configured.\n│ Register a gateway with: openshell gateway add <endpoint>",
    } as Partial<ShellProbeResult>,
  };
  const openshell = vi
    .spyOn(sandbox, "openshell")
    .mockImplementation(async (args = [], options) => {
      calls.push(args.slice(0, 2).join(" "));
      expect(options?.env?.OPENSHELL_GATEWAY).toBe(gateway.name);
      const results: Record<string, ShellProbeResult> = {
        gateway: response(gateway.response),
        sandbox: response(),
      };
      expect(results).toHaveProperty(args[0]);
      return results[args[0]]!;
    });
  const cleanup = new CleanupRegistry();
  const prepare = (orphanGatewayName?: string) =>
    prepareOwnedSandboxForOnboard(host, sandbox, cleanup, "e2e-mcp-bridge", orphanGatewayName);
  return { calls, host, sandbox, openshell, gateway, presentGateway, cleanup, prepare };
}

describe("owned-sandbox cleanup", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENSHELL_GATEWAY", "nemoclaw");
    state.registered = false;
    state.gatewayPort = undefined;
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

  it("recovers only a registered missing gateway with the selected provider context", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "podman");
    vi.stubEnv("OPENSHELL_PODMAN_SOCKET", "/run/user/1000/podman/podman.sock");
    const f = fixture();
    state.registered = true;
    f.host.command.mockImplementation(async (command, argv, options) => {
      expect(command).toBe(process.execPath);
      expect(argv[1]).toContain("startGatewayForRecovery");
      expect(options.env).toMatchObject({
        NEMOCLAW_GATEWAY_RUNTIME: "podman",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
      });
      f.calls.push("recover gateway");
      f.gateway.response = f.presentGateway;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        signal: null,
        timedOut: false,
        command: [],
        artifacts: { stdout: "", stderr: "", result: "" },
      };
    });
    try {
      await f.prepare();
      expect(f.calls).toEqual([
        "gateway info",
        "recover gateway",
        "gateway info",
        "sandbox delete",
        "cli:precleanup-destroy-sandbox",
      ]);
      expect((await f.cleanup.runAll()).failures).toEqual([]);
      expect(f.host.command).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when recovery does not restore the registered gateway", async () => {
    const f = fixture();
    state.registered = true;
    f.host.command.mockResolvedValue({ exitCode: 0 } as ShellProbeResult);
    await expect(f.prepare()).rejects.toThrow("is still absent");
    expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["gateway info", "gateway info"]);
  });

  it("recovers a registration acquired after preparation when its gateway disappears", async () => {
    const f = fixture();
    await f.prepare();
    state.registered = true;
    f.host.command.mockImplementation(async () => {
      f.calls.push("recover gateway");
      f.gateway.response = f.presentGateway;
      return { exitCode: 0 } as ShellProbeResult;
    });
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.calls).toEqual([
      "gateway info",
      "gateway info",
      "recover gateway",
      "gateway info",
      "sandbox delete",
      "cli:cleanup-destroy-sandbox",
    ]);
  });

  it("uses the retained nondefault gateway for inspection, recovery, deletion and reconciliation", async () => {
    const f = fixture();
    state.registered = true;
    state.gatewayPort = 9443;
    f.gateway.name = "nemoclaw-9443";
    f.host.command.mockImplementation(async (_command, argv, options) => {
      expect(argv.at(-1)).toBe("nemoclaw-9443");
      expect(options.env?.OPENSHELL_GATEWAY).toBe("nemoclaw-9443");
      f.gateway.response = { stdout: JSON.stringify({ gateway: "nemoclaw-9443" }) };
      return { exitCode: 0 } as ShellProbeResult;
    });
    await f.prepare("nemoclaw-8888");
    expect(f.host.cleanupSandbox).toHaveBeenCalledWith(
      "e2e-mcp-bridge",
      expect.objectContaining({
        env: expect.objectContaining({ OPENSHELL_GATEWAY: "nemoclaw-9443" }),
      }),
    );
    expect(f.openshell.mock.calls.map(([args]) => args)).toEqual([
      ["gateway", "info", "-g", "nemoclaw-9443", "-o", "json"],
      ["gateway", "info", "-g", "nemoclaw-9443", "-o", "json"],
      ["sandbox", "delete", "e2e-mcp-bridge"],
    ]);
    state.gatewayPort = 9554;
    f.gateway.name = "nemoclaw-9554";
    f.gateway.response = { stdout: JSON.stringify({ gateway: "nemoclaw-9554" }) };
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.host.cleanupSandbox).toHaveBeenLastCalledWith(
      "e2e-mcp-bridge",
      expect.objectContaining({
        env: expect.objectContaining({ OPENSHELL_GATEWAY: "nemoclaw-9554" }),
      }),
    );
  });

  it("rejects invalid retained gateway identity before any gateway operation", async () => {
    const f = fixture();
    state.registered = true;
    state.gatewayPort = -1;
    await expect(f.prepare()).rejects.toThrow("Invalid persisted sandbox gateway binding");
    expect(f.openshell).not.toHaveBeenCalled();
    expect(f.host.command).not.toHaveBeenCalled();
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

it("rejects an invalid explicit orphan gateway before cleanup mutation", async () => {
  state.registered = false;
  const f = fixture();
  await expect(f.prepare("unrelated")).rejects.toThrow("Invalid persisted sandbox gateway binding");
  expect(f.openshell).not.toHaveBeenCalled();
  expect(f.host.command).not.toHaveBeenCalled();
});
