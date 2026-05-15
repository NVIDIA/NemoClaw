// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildAuthenticatedDashboardUrl,
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
    expect(getDashboardForwardTarget("http://10.0.0.25:18789", { isWsl: false })).toBe("0.0.0.0:18789");
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
      label: "Alt 1",
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
