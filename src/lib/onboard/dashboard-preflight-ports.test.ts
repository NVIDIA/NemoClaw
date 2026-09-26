// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { HERMES_OPENAI_API_PORT } from "../core/ports";
import { acceptManagedListener, selectPreflightSandboxName } from "./gateway/entry-decisions";
import {
  assertDashboardPortNotReserved,
  buildRequiredPreflightPorts,
  isRegisteredDashboardForwardOwned,
} from "./preflight-ports";

const OWNED_FORWARD = {
  gatewayEndpoint: "https://127.0.0.1:8080",
  gatewayName: "nemoclaw",
  workspace: "default",
  sandboxName: "requested",
  localHost: "127.0.0.1",
  port: 18789,
} as const;

it.each([null, 4242])(
  "listener admission reports without publishing PID state [case %#]",
  (pid) => {
    const reportAccepted = vi.fn();
    expect(acceptManagedListener(pid, reportAccepted)).toBe(pid !== null);
    expect(reportAccepted.mock.calls).toEqual(pid === null ? [] : [[]]);
  },
);

it.each([
  { name: "requested", nonInteractive: true, expected: "requested" },
  { name: "recorded", nonInteractive: false, expected: "recorded" },
  { name: null, nonInteractive: true, expected: "my-assistant" },
  { name: null, nonInteractive: false, expected: null },
])(
  "preflight resolves only a known or automatic sandbox name [case %#]",
  ({ name, nonInteractive, expected }) => {
    const readDefaultName = vi.fn(() => "my-assistant");
    expect(selectPreflightSandboxName(name, nonInteractive, readDefaultName)).toBe(expected);
    expect(readDefaultName).toHaveBeenCalledTimes(name === null && nonInteractive ? 1 : 0);
  },
);

describe("registered dashboard forward preflight", () => {
  it.each(["owned", "absent", "stale", "foreign"] as const)(
    "admits only current ownership when the observation is %s",
    async (state) => {
      const observe = vi.fn(async () => [{ state, forward: OWNED_FORWARD }]);
      const createForwardPortObserver = vi.fn(() => observe);
      await expect(
        isRegisteredDashboardForwardOwned("requested", 18789, {
          getSandbox: () => ({ dashboardPort: 18789 }),
          createForwardPortObserver,
        }),
      ).resolves.toBe(state === "owned");
      expect(createForwardPortObserver).toHaveBeenCalledExactlyOnceWith("requested");
      expect(observe).toHaveBeenCalledExactlyOnceWith([18789]);
    },
  );

  it.each([
    { sandboxName: null, sandbox: { dashboardPort: 18789 } },
    { sandboxName: "requested", sandbox: null },
    { sandboxName: "requested", sandbox: { dashboardPort: 18790 } },
  ])(
    "rejects an unbound or mismatched registered dashboard [case %#]",
    async ({ sandboxName, sandbox }) => {
      const createForwardPortObserver = vi.fn();
      await expect(
        isRegisteredDashboardForwardOwned(sandboxName, 18789, {
          getSandbox: () => sandbox,
          createForwardPortObserver,
        }),
      ).resolves.toBe(false);
      expect(createForwardPortObserver).not.toHaveBeenCalled();
    },
  );

  it.each([
    { observations: [] },
    {
      observations: [
        { state: "owned" as const, forward: { ...OWNED_FORWARD, sandboxName: "sibling" } },
      ],
    },
    { observations: [{ state: "owned" as const, forward: { ...OWNED_FORWARD, port: 18790 } }] },
    {
      observations: [
        {
          state: "indeterminate" as const,
          forward: OWNED_FORWARD,
          error: {
            kind: "transport" as const,
            message: "The OpenShell forward transport failed." as const,
          },
        },
      ],
    },
  ])("rejects incomplete or mismatched ownership evidence [case %#]", async ({ observations }) => {
    await expect(
      isRegisteredDashboardForwardOwned("requested", 18789, {
        getSandbox: () => ({ dashboardPort: 18789 }),
        createForwardPortObserver: () => async () => observations,
      }),
    ).resolves.toBe(false);
  });

  it("rejects failed observation and a registration that changes during observation", async () => {
    const getSandbox = vi
      .fn()
      .mockReturnValueOnce({ dashboardPort: 18789 })
      .mockReturnValue({ dashboardPort: 18790 });
    await expect(
      isRegisteredDashboardForwardOwned("requested", 18789, {
        getSandbox,
        createForwardPortObserver: () => async () => [{ state: "owned", forward: OWNED_FORWARD }],
      }),
    ).resolves.toBe(false);
    await expect(
      isRegisteredDashboardForwardOwned("requested", 18789, {
        getSandbox: () => ({ dashboardPort: 18789 }),
        createForwardPortObserver: () =>
          vi.fn().mockRejectedValue(new Error("observation unavailable")),
      }),
    ).resolves.toBe(false);
  });
});

describe("buildRequiredPreflightPorts", () => {
  it("returns the gateway only when no dashboard port is requested (auto-allocation)", () => {
    expect(
      buildRequiredPreflightPorts({
        gatewayPort: 8080,
        dashboardPort: null,
        dashboardLabel: "NemoClaw dashboard",
      }),
    ).toEqual([
      {
        kind: "gateway",
        port: 8080,
        label: "OpenShell gateway",
        envVar: "NEMOCLAW_GATEWAY_PORT",
      },
    ]);
  });

  it("includes the dashboard port when one is explicitly requested", () => {
    expect(
      buildRequiredPreflightPorts({
        gatewayPort: 8080,
        dashboardPort: 18789,
        dashboardLabel: "NemoClaw dashboard",
      }),
    ).toEqual([
      {
        kind: "gateway",
        port: 8080,
        label: "OpenShell gateway",
        envVar: "NEMOCLAW_GATEWAY_PORT",
      },
      {
        kind: "dashboard",
        port: 18789,
        label: "NemoClaw dashboard",
        envVar: "NEMOCLAW_DASHBOARD_PORT",
      },
    ]);
  });

  it("keeps equal-number gateway and dashboard entries role-distinct (#6576)", () => {
    expect(
      buildRequiredPreflightPorts({
        gatewayPort: 8080,
        dashboardPort: 8080,
        dashboardLabel: "NemoClaw dashboard",
      }),
    ).toEqual([
      {
        kind: "gateway",
        port: 8080,
        label: "OpenShell gateway",
        envVar: "NEMOCLAW_GATEWAY_PORT",
      },
      {
        kind: "dashboard",
        port: 8080,
        label: "NemoClaw dashboard",
        envVar: "NEMOCLAW_DASHBOARD_PORT",
      },
    ]);
  });
});

describe("assertDashboardPortNotReserved (#4984)", () => {
  it("rejects the reserved Hermes API port 8642 via fail()", () => {
    const fail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    expect(() => assertDashboardPortNotReserved(HERMES_OPENAI_API_PORT, fail)).toThrow(
      "[SECURITY] Invalid dashboard port 8642 - reserved for the Hermes OpenAI-compatible API",
    );
    expect(fail).toHaveBeenCalledOnce();
  });

  it("allows a normal dashboard port and a null (auto-allocated) port", () => {
    const fail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    expect(() => assertDashboardPortNotReserved(18789, fail)).not.toThrow();
    expect(() => assertDashboardPortNotReserved(null, fail)).not.toThrow();
    expect(fail).not.toHaveBeenCalled();
  });
});
