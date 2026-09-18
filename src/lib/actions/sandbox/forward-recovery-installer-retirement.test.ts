// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellForwardAdapter } from "../../adapters/openshell/forward";
import type { GatewayOwner } from "../../onboard/gateway-ownership";
import type { SandboxEntry } from "../../state/registry/types";
import { retireRegisteredLegacyDashboardForwards } from "./forward-recovery";

const owner: GatewayOwner = {
  endpoint: null,
  gatewayName: "nemoclaw",
  gatewayPort: 8_080,
  mode: "nemoclaw-managed",
  requiredCapabilities: [],
  source: "packaged-service",
  stateDir: null,
  supervisor: null,
};

function harness(options: {
  entries?: SandboxEntry[];
  result?: Awaited<ReturnType<OpenShellForwardAdapter["retireLegacyForward"]>>;
}) {
  const entries = options.entries ?? [
    { name: "beta", dashboardPort: 18_790 },
    { name: "alpha", dashboardPort: 18_789 },
  ];
  const current = new Map(entries.map((entry) => [entry.name, entry]));
  const retireLegacyForward = vi.fn<OpenShellForwardAdapter["retireLegacyForward"]>(
    async (request) => {
      await request.assertCurrent?.();
      await request.authorize(request.forward);
      return options.result ?? { state: "retired", forward: request.forward };
    },
  );
  const summary = () =>
    retireRegisteredLegacyDashboardForwards({
      forwardAdapterForAuthority: () => ({ retireLegacyForward }),
      getRegisteredAgent: (entry) =>
        entry?.agent === "terminal" ? ({ runtime: { kind: "terminal" } } as never) : null,
      getSandbox: (name) => current.get(name) ?? null,
      hasGatewayRuntime: (agent) => agent?.runtime?.kind !== "terminal",
      listSandboxes: () => ({ sandboxes: entries, defaultSandbox: entries[0]?.name ?? null }),
      resolveForwardRuntimeAuthority: (gatewayName) => ({
        authority: {
          endpoint: "https://127.0.0.1:8080",
          owner: { ...owner, gatewayName },
        },
        runtime: {
          gatewayEndpoint: "https://127.0.0.1:8080",
          gatewayName,
          workspace: "default",
        },
      }),
      resolveSandboxDashboardPort: (name) => current.get(name)?.dashboardPort ?? 18_789,
    });
  return { current, retireLegacyForward, summary };
}

describe("installer legacy dashboard forward retirement", () => {
  it("retires every registered legacy dashboard forward in stable sandbox order", async () => {
    const test = harness({});

    await expect(test.summary()).resolves.toEqual({ retired: 2, unchanged: 0, skipped: 0 });
    expect(test.retireLegacyForward.mock.calls.map(([request]) => request.forward)).toEqual([
      expect.objectContaining({ sandboxName: "alpha", port: 18_789 }),
      expect.objectContaining({ sandboxName: "beta", port: 18_790 }),
    ]);
  });

  it("skips terminal sandboxes and accepts a forward that does not need retirement", async () => {
    const test = harness({
      entries: [
        { name: "terminal-box", agent: "terminal" },
        { name: "openclaw-box", dashboardPort: 18_789 },
      ],
      result: {
        state: "not_needed",
        observation: {
          state: "absent",
          forward: {
            gatewayEndpoint: "https://127.0.0.1:8080",
            gatewayName: "nemoclaw",
            localHost: "127.0.0.1",
            port: 18_789,
            sandboxName: "openclaw-box",
            workspace: "default",
          },
        },
      },
    });

    await expect(test.summary()).resolves.toEqual({ retired: 0, unchanged: 1, skipped: 1 });
    expect(test.retireLegacyForward).toHaveBeenCalledOnce();
  });

  it("fails closed when the adapter cannot prove exact retirement", async () => {
    const forward = {
      gatewayEndpoint: "https://127.0.0.1:8080",
      gatewayName: "nemoclaw",
      localHost: "127.0.0.1" as const,
      port: 18_789,
      sandboxName: "alpha",
      workspace: "default",
    };
    const test = harness({
      entries: [{ name: "alpha", dashboardPort: 18_789 }],
      result: {
        state: "refused",
        observation: { state: "foreign", forward },
      },
    });

    await expect(test.summary()).rejects.toThrow(
      "Could not prove legacy dashboard forward retirement for sandbox 'alpha'.",
    );
  });

  it("rejects a dashboard-port change at the final authority fence", async () => {
    const test = harness({ entries: [{ name: "alpha", dashboardPort: 18_789 }] });
    test.retireLegacyForward.mockImplementationOnce(async (request) => {
      test.current.set("alpha", { name: "alpha", dashboardPort: 18_790 });
      await request.authorize(request.forward);
      return { state: "retired", forward: request.forward };
    });

    await expect(test.summary()).rejects.toThrow(
      "Sandbox forward registration changed during installer retirement",
    );
  });
});
