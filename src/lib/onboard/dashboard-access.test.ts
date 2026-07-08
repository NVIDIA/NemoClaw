// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthenticatedDashboardUrl,
  buildDashboardChain,
  dashboardUrlForDisplay,
  getDashboardAccessInfo,
  getDashboardForwardPort,
  getDashboardForwardStartCommand,
  getDashboardForwardTarget,
  getDashboardGuidanceLines,
  getWslHostAddress,
} from "./dashboard-access";

describe("dashboard access helpers", () => {
  it("derives forward port and target from chat UI URLs", () => {
    expect(getDashboardForwardPort("http://127.0.0.1:18789", { isWsl: false })).toBe("18789");
    expect(getDashboardForwardTarget("http://127.0.0.1:18789", { isWsl: false })).toBe("18789");
    expect(getDashboardForwardTarget("http://10.0.0.25:18789", { isWsl: false })).toBe(
      "0.0.0.0:18789",
    );
  });

  it("builds the OpenShell forward start command with the resolved target", () => {
    const openshellShellCommand = vi.fn((args: string[]) => `openshell ${args.join(" ")}`);

    expect(
      getDashboardForwardStartCommand("alpha", {
        chatUiUrl: "http://10.0.0.25:18789",
        openshellShellCommand,
      }),
    ).toBe("openshell forward start --background 0.0.0.0:18789 alpha");
  });

  it("redacts token fragments for display", () => {
    expect(buildAuthenticatedDashboardUrl("http://127.0.0.1:18789/", "secret token")).toBe(
      "http://127.0.0.1:18789/#token=secret%20token",
    );
    expect(dashboardUrlForDisplay("http://127.0.0.1:18789/#token=secret", (value) => value)).toBe(
      "http://127.0.0.1:18789/",
    );
  });

  it("detects a WSL host address only when WSL is active", () => {
    const runCapture = vi.fn(() => "172.22.1.1 10.0.0.2\n");

    expect(getWslHostAddress({ isWsl: true, runCapture })).toBe("172.22.1.1");
    expect(getWslHostAddress({ isWsl: false, runCapture })).toBeNull();
  });

  it("builds dashboard access entries including a WSL URL", () => {
    const access = getDashboardAccessInfo("alpha", {
      token: "secret",
      chatUiUrl: "http://127.0.0.1:18789",
      isWsl: true,
      wslHostAddress: "172.22.1.1",
    });

    expect(access).toContainEqual({
      label: "WSL fallback",
      url: "http://172.22.1.1:18789/#token=secret",
    });
  });

  it("builds dashboard guidance for WSL and empty access lists", () => {
    expect(
      getDashboardGuidanceLines([], {
        chatUiUrl: "http://127.0.0.1:18789",
        isWsl: true,
      }),
    ).toEqual([
      "Port 18789 must be forwarded before opening these URLs.",
      "WSL detected: if localhost fails in Windows, use the WSL host IP shown by `hostname -I`.",
      "No dashboard URLs were generated.",
    ]);
  });
});

// The pure buildChain({ bindOverride }) decision is covered in
// src/lib/dashboard/contract.test.ts. These tests pin the I/O boundary:
// readBindOverride() reads NEMOCLAW_DASHBOARD_BIND from the env and
// buildDashboardChain wires it into buildChain. The dangerous NEGATIVE cases
// (invalid / loopback values must NOT open a remote bind) were previously only
// asserted in the live dashboard-remote-bind E2E.
describe("NEMOCLAW_DASHBOARD_BIND remote-bind opt-in gate (#3259)", () => {
  const LOOPBACK_URL = "http://127.0.0.1:18789";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("opens the remote bind when env NEMOCLAW_DASHBOARD_BIND=0.0.0.0", () => {
    const chain = buildDashboardChain(LOOPBACK_URL, {
      env: { NEMOCLAW_DASHBOARD_BIND: "0.0.0.0" },
    });
    expect(chain.bindAddress).toBe("0.0.0.0");
    expect(chain.forwardTarget).toBe("0.0.0.0:18789");
    expect(
      getDashboardForwardTarget(LOOPBACK_URL, { env: { NEMOCLAW_DASHBOARD_BIND: "0.0.0.0" } }),
    ).toBe("0.0.0.0:18789");
  });

  it("stays loopback when env NEMOCLAW_DASHBOARD_BIND is unset", () => {
    const chain = buildDashboardChain(LOOPBACK_URL, { env: {} });
    expect(chain.bindAddress).toBe("127.0.0.1");
    expect(chain.forwardTarget).toBe("18789");
  });

  it("stays loopback when env NEMOCLAW_DASHBOARD_BIND is empty", () => {
    const chain = buildDashboardChain(LOOPBACK_URL, {
      env: { NEMOCLAW_DASHBOARD_BIND: "" },
    });
    expect(chain.bindAddress).toBe("127.0.0.1");
    expect(chain.forwardTarget).toBe("18789");
  });

  it("stays loopback when env NEMOCLAW_DASHBOARD_BIND=127.0.0.1", () => {
    const chain = buildDashboardChain(LOOPBACK_URL, {
      env: { NEMOCLAW_DASHBOARD_BIND: "127.0.0.1" },
    });
    expect(chain.bindAddress).toBe("127.0.0.1");
    expect(chain.forwardTarget).toBe("18789");
  });

  it.each([
    "0.0.0.0; rm -rf",
    "1.2.3.4",
    "true",
    "10.0.0.5",
    " 0.0.0.0",
    "0.0.0.0 ",
  ])("does NOT open a remote bind for invalid env value %j", (value) => {
    const chain = buildDashboardChain(LOOPBACK_URL, {
      env: { NEMOCLAW_DASHBOARD_BIND: value },
    });
    expect(chain.bindAddress).toBe("127.0.0.1");
    expect(chain.forwardTarget).toBe("18789");
  });

  it("falls back to process.env when no options.env override is provided", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const chain = buildDashboardChain(LOOPBACK_URL);
    expect(chain.bindAddress).toBe("0.0.0.0");
    expect(chain.forwardTarget).toBe("0.0.0.0:18789");
  });

  it("does NOT open a remote bind for invalid process.env value", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0; rm -rf");
    const chain = buildDashboardChain(LOOPBACK_URL);
    expect(chain.bindAddress).toBe("127.0.0.1");
    expect(chain.forwardTarget).toBe("18789");
  });
});
