// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  ensureHermesDashboardPortForwardIfEnabled,
  getHermesDashboardRecoveryConfig,
  recoverHermesDashboardProcessIfEnabled,
} from "../../../../dist/lib/actions/sandbox/hermes-dashboard-recovery";

describe("Hermes dashboard recovery helpers", () => {
  it("reads recovery config only for enabled Hermes dashboard sandboxes", () => {
    expect(
      getHermesDashboardRecoveryConfig("alpha", () => ({
        name: "alpha",
        agent: "hermes",
        hermesDashboardEnabled: true,
        hermesDashboardPort: 9119,
        hermesDashboardInternalPort: 19119,
        hermesDashboardTui: true,
      })),
    ).toEqual({ publicPort: 9119, internalPort: 19119, tuiEnabled: true });

    expect(
      getHermesDashboardRecoveryConfig("alpha", () => ({
        name: "alpha",
        agent: "openclaw",
        hermesDashboardEnabled: true,
        hermesDashboardPort: 9119,
        hermesDashboardInternalPort: 19119,
      })),
    ).toBeNull();

    expect(
      getHermesDashboardRecoveryConfig("alpha", () => ({
        name: "alpha",
        agent: "hermes",
        hermesDashboardEnabled: true,
        hermesDashboardPort: "9119" as unknown as number,
        hermesDashboardInternalPort: 19119,
      })),
    ).toBeNull();

    expect(
      getHermesDashboardRecoveryConfig("alpha", () => ({
        name: "alpha",
        agent: "hermes",
        hermesDashboardEnabled: true,
        hermesDashboardPort: 1023,
        hermesDashboardInternalPort: 19119,
      })),
    ).toBeNull();

    expect(
      getHermesDashboardRecoveryConfig("alpha", () => ({
        name: "alpha",
        agent: "hermes",
        hermesDashboardEnabled: true,
        hermesDashboardPort: 9119,
        hermesDashboardInternalPort: 1023,
      })),
    ).toBeNull();
  });

  it("restarts the dashboard forward only when the recorded forward is unhealthy", () => {
    const ensurePortForward = vi.fn(() => true);
    const getRecoveryConfig = () => ({
      publicPort: 9119,
      internalPort: 19119,
      tuiEnabled: false,
    });

    expect(
      ensureHermesDashboardPortForwardIfEnabled("alpha", {
        getRecoveryConfig,
        isPortForwardHealthy: () => false,
        ensurePortForward,
      }),
    ).toBe(true);
    expect(ensurePortForward).toHaveBeenCalledWith("alpha", 9119);

    expect(
      ensureHermesDashboardPortForwardIfEnabled("alpha", {
        getRecoveryConfig,
        isPortForwardHealthy: () => true,
        ensurePortForward,
      }),
    ).toBe(false);

    const ensurePortForwardWhenOccupied = vi.fn(() => true);
    expect(
      ensureHermesDashboardPortForwardIfEnabled("alpha", {
        getRecoveryConfig,
        isPortForwardHealthy: () => "occupied",
        ensurePortForward: ensurePortForwardWhenOccupied,
      }),
    ).toBe(false);
    expect(ensurePortForwardWhenOccupied).not.toHaveBeenCalled();

    expect(
      ensureHermesDashboardPortForwardIfEnabled("alpha", {
        getRecoveryConfig: () => null,
        isPortForwardHealthy: () => false,
        ensurePortForward,
      }),
    ).toBeNull();
  });

  it("reports dashboard process recovery only for successful recovery markers", () => {
    const buildRecoveryScript = vi.fn(() => "dashboard recovery");
    const getRecoveryConfig = () => ({
      publicPort: 9119,
      internalPort: 19119,
      tuiEnabled: true,
    });

    expect(
      recoverHermesDashboardProcessIfEnabled("alpha", {
        getRecoveryConfig,
        buildRecoveryScript,
        executeCommand: (_sandboxName, command) => ({
          status: 0,
          stdout: command === "dashboard recovery" ? "DASHBOARD_PID=42" : "",
          stderr: "",
        }),
      }),
    ).toBe(true);
    expect(buildRecoveryScript).toHaveBeenCalledWith({
      publicPort: 9119,
      internalPort: 19119,
      tuiEnabled: true,
    });

    expect(
      recoverHermesDashboardProcessIfEnabled("alpha", {
        getRecoveryConfig,
        buildRecoveryScript,
        executeCommand: () => ({ status: 1, stdout: "DASHBOARD_FAILED", stderr: "" }),
      }),
    ).toBe(false);

    expect(
      recoverHermesDashboardProcessIfEnabled("alpha", {
        getRecoveryConfig: () => null,
        executeCommand: () => ({ status: 0, stdout: "DASHBOARD_PID=42", stderr: "" }),
      }),
    ).toBeNull();
  });
});
