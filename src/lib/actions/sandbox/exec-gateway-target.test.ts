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
    });
    const run = vi.fn(async () => {
      order.push("run");
      return { status: 0 };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await execSandbox(
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
    ).catch(() => {});

    expect(selectGateway).toHaveBeenCalledWith("beta");
    expect(run).toHaveBeenCalled();
    expect(order.indexOf("select:beta")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("select:beta")).toBeLessThan(order.indexOf("run"));
  });
});
