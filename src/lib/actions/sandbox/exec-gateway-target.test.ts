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
    vi.restoreAllMocks();
  });

  it("selects the sandbox's owning gateway before dispatching the exec", async () => {
    const order: string[] = [];
    const selectGateway = vi.fn((name: string) => {
      order.push(`select:${name}`);
      return { outcome: "selected" as const, gatewayName: name };
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
    expect(order.indexOf("select:beta")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("select:beta")).toBeLessThan(order.indexOf("run"));
  });

  it("selects the owning gateway before the workdir probe when a workdir is set", async () => {
    const order: string[] = [];
    const selectGateway = vi.fn((name: string) => {
      order.push(`select:${name}`);
      return { outcome: "selected" as const, gatewayName: name };
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
