// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { HERMES_OPENAI_API_PORT } from "../core/ports";
import { assertDashboardPortNotReserved, buildRequiredPreflightPorts } from "./preflight-ports";

describe("buildRequiredPreflightPorts", () => {
  it("returns the gateway only when no dashboard port is requested (auto-allocation)", () => {
    expect(
      buildRequiredPreflightPorts({
        gatewayPort: 8080,
        dashboardPort: null,
        dashboardLabel: "NemoClaw dashboard",
      }),
    ).toEqual([{ port: 8080, label: "OpenShell gateway", envVar: "NEMOCLAW_GATEWAY_PORT" }]);
  });

  it("includes the dashboard port when one is explicitly requested", () => {
    expect(
      buildRequiredPreflightPorts({
        gatewayPort: 8080,
        dashboardPort: 18789,
        dashboardLabel: "NemoClaw dashboard",
      }),
    ).toEqual([
      { port: 8080, label: "OpenShell gateway", envVar: "NEMOCLAW_GATEWAY_PORT" },
      { port: 18789, label: "NemoClaw dashboard", envVar: "NEMOCLAW_DASHBOARD_PORT" },
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
