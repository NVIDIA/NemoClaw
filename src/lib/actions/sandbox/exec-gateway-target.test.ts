// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { execSandbox, type SandboxExecCleanupDeps } from "./exec";

const cleanupSkipped: SandboxExecCleanupDeps = {
  getSandbox: () => null,
  inspectMutableConfigPerms: (() => {
    throw new Error("cleanup should be skipped");
  }) as unknown as SandboxExecCleanupDeps["inspectMutableConfigPerms"],
  repairMutableConfigPerms: (() => {
    throw new Error("cleanup should be skipped");
  }) as unknown as SandboxExecCleanupDeps["repairMutableConfigPerms"],
};

describe("execSandbox gateway targeting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("selects the sandbox's owning gateway before dispatching the exec", async () => {
    const order: string[] = [];
    const selectGateway = vi.fn((name: string) => {
      order.push(`select:${name}`);
      return { outcome: "selected" as const, gatewayName: name };
    });
    const run = vi.fn(async (_binary: string, _args: readonly string[]) => {
      order.push("run");
      return { status: 0 };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["hostname"],
        {},
        {
          resolveBinary: () => "openshell",
          selectGateway,
          run,
          cleanupDeps: cleanupSkipped,
          policyHint: {
            now: () => 0,
            env: {},
            probeLogs: () => "",
            enableAudit: () => {},
            sleep: async () => {},
            attempts: 1,
            writeStderr: () => {},
          },
        },
      ),
    ).rejects.toThrow("__exit_0__");

    expect(selectGateway).toHaveBeenCalledWith("beta");
    expect(run).toHaveBeenCalled();
    const execArgs = run.mock.calls[0]?.[1] ?? [];
    expect(execArgs.slice(0, 7)).toEqual(["sandbox", "exec", "--name", "beta", "-g", "beta", "--"]);
    expect(execArgs.at(-2)).toBe("nemoclaw-runtime-env");
    expect(execArgs.at(-1)).toBe("hostname");
    expect(order.indexOf("select:beta")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("select:beta")).toBeLessThan(order.indexOf("run"));
  });

  it("selects the owning gateway before the workdir probe when a workdir is set", async () => {
    const order: string[] = [];
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-sibling");
    const selectGateway = vi.fn((name: string) => {
      order.push(`select:${name}`);
      process.env.OPENSHELL_GATEWAY = "drifted-sibling";
      return { outcome: "selected" as const, gatewayName: "nemoclaw-8091" };
    });
    const probeWorkdir = vi.fn((_binary: string, _args: readonly string[]) => {
      order.push("probe");
      return { status: 0, error: undefined };
    });
    const run = vi.fn(async (_binary: string, _args: readonly string[]) => {
      order.push("run");
      return { status: 0 };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["hostname"],
        { workdir: "/work" },
        {
          resolveBinary: () => "openshell",
          selectGateway,
          probeWorkdir,
          run,
          cleanupDeps: cleanupSkipped,
          policyHint: {
            now: () => 0,
            env: {},
            probeLogs: () => "",
            enableAudit: () => {},
            sleep: async () => {},
            attempts: 1,
            writeStderr: () => {},
          },
        },
      ),
    ).rejects.toThrow("__exit_0__");

    expect(order).toEqual(["select:beta", "probe", "run"]);
    expect(process.env.OPENSHELL_GATEWAY).toBe("drifted-sibling");
    expect(probeWorkdir.mock.calls[0]?.[1]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "beta",
      "-g",
      "nemoclaw-8091",
      "--",
      "test",
      "-d",
      "/work",
    ]);
    const execArgs = run.mock.calls[0]?.[1] ?? [];
    expect(execArgs.slice(0, 9)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "beta",
      "-g",
      "nemoclaw-8091",
      "--workdir",
      "/work",
      "--",
    ]);
    expect(execArgs.at(-2)).toBe("nemoclaw-runtime-env");
    expect(execArgs.at(-1)).toBe("hostname");
  });

  it("rejects a direct endpoint override before selecting, probing, or dispatching", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://sibling.invalid");
    const resolveBinary = vi.fn(() => "openshell");
    const selectGateway = vi.fn();
    const probeWorkdir = vi.fn();
    const run = vi.fn();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["hostname"],
        { workdir: "/work" },
        { resolveBinary, selectGateway, probeWorkdir, run },
      ),
    ).rejects.toThrow("__exit_1__");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("OPENSHELL_GATEWAY_ENDPOINT is set"),
    );
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(selectGateway).not.toHaveBeenCalled();
    expect(probeWorkdir).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps post-exec policy probes pinned after ambient gateway selection drifts", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-sibling");
    const enableAudit = vi.fn();
    const probeLogs = vi.fn(() => "");
    const selectGateway = vi.fn(() => {
      process.env.OPENSHELL_GATEWAY = "drifted-sibling";
      return { outcome: "selected" as const, gatewayName: "nemoclaw-8091" };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["curl", "https://example.invalid"],
        {},
        {
          resolveBinary: () => "openshell",
          selectGateway,
          run: async () => ({ status: 56 }),
          cleanupDeps: cleanupSkipped,
          policyHint: {
            now: () => 0,
            env: {},
            enableAudit,
            probeLogs,
            attempts: 1,
            sleep: async () => {},
            writeStderr: () => {},
          },
        },
      ),
    ).rejects.toThrow("__exit_56__");

    expect(process.env.OPENSHELL_GATEWAY).toBe("drifted-sibling");
    expect(enableAudit).toHaveBeenCalledWith("beta", "nemoclaw-8091");
    expect(probeLogs).toHaveBeenCalledWith("beta", "nemoclaw-8091");
  });

  it("aborts before the workdir probe and exec when gateway selection fails", async () => {
    const order: string[] = [];
    const selectGateway = vi.fn(() => {
      order.push("select");
      return { outcome: "failed" as const, gatewayName: "nemoclaw-8091" };
    });
    const probeWorkdir = vi.fn(() => {
      order.push("probe");
      return { status: 0, error: undefined };
    });
    const run = vi.fn(async () => {
      order.push("run");
      return { status: 0 };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["hostname"],
        { workdir: "/work" },
        {
          resolveBinary: () => "openshell",
          selectGateway,
          probeWorkdir,
          run,
          cleanupDeps: cleanupSkipped,
        },
      ),
    ).rejects.toThrow("__exit_1__");

    expect(order).toEqual(["select"]);
    expect(probeWorkdir).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
