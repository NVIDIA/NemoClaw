// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayReuseState } from "../state/gateway";
import type { GatewayContainerState } from "./gateway-container-running";
import { applyHealthyPortReuse, classifyGatewayPortReuse } from "./gateway-stale-port-reuse";

const NON_HEALTHY_STATES: GatewayReuseState[] = [
  "active-unnamed",
  "foreign-active",
  "stale",
  "missing",
];

describe("classifyGatewayPortReuse", () => {
  it("returns stale when recorded healthy but the legacy container is missing", () => {
    expect(
      classifyGatewayPortReuse({
        gatewayReuseState: "healthy",
        supportsLifecycleCommands: true,
        containerState: "missing",
      }),
    ).toBe("stale");
  });

  it("returns reuse when recorded healthy and the container is live", () => {
    expect(
      classifyGatewayPortReuse({
        gatewayReuseState: "healthy",
        supportsLifecycleCommands: true,
        containerState: "running",
      }),
    ).toBe("reuse");
  });

  it("returns reuse when recorded healthy and the container probe was inconclusive", () => {
    expect(
      classifyGatewayPortReuse({
        gatewayReuseState: "healthy",
        supportsLifecycleCommands: true,
        containerState: "unknown",
      }),
    ).toBe("reuse");
  });

  it("returns reuse when the CLI lacks lifecycle commands, regardless of container state", () => {
    for (const containerState of ["missing", "running", "unknown"] as GatewayContainerState[]) {
      expect(
        classifyGatewayPortReuse({
          gatewayReuseState: "healthy",
          supportsLifecycleCommands: false,
          containerState,
        }),
      ).toBe("reuse");
    }
  });

  it("returns skip for any non-healthy recorded state", () => {
    for (const gatewayReuseState of NON_HEALTHY_STATES) {
      expect(
        classifyGatewayPortReuse({
          gatewayReuseState,
          supportsLifecycleCommands: true,
          containerState: "missing",
        }),
      ).toBe("skip");
    }
  });
});

const BASE_INPUT = {
  port: 8080,
  gatewayPort: 8080,
  dashboardPort: 18789,
  label: "OpenShell gateway",
  runtimeDisplayName: "NemoClaw",
  gatewayName: "nemoclaw",
  gatewayReuseState: "healthy" as GatewayReuseState,
  portCheckOptions: undefined,
  supportsLifecycleCommands: true,
};

describe("applyHealthyPortReuse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when recorded state is not healthy", async () => {
    const result = await applyHealthyPortReuse({
      ...BASE_INPUT,
      gatewayReuseState: "missing",
      destroyGateway: () => true,
      runOpenshell: vi.fn(),
      checkPortAvailable: vi.fn(),
      verifyGatewayContainerRunning: vi.fn(),
    });
    expect(result).toBeNull();
  });

  it("returns null for ports that are neither the gateway nor dashboard port", async () => {
    const result = await applyHealthyPortReuse({
      ...BASE_INPUT,
      port: 9999,
      destroyGateway: () => true,
      runOpenshell: vi.fn(),
      checkPortAvailable: vi.fn(),
      verifyGatewayContainerRunning: vi.fn(),
    });
    expect(result).toBeNull();
  });

  it("cleans up stale metadata and returns downgraded state when the port frees up", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const destroyGateway = vi.fn(() => true);
    const runOpenshell = vi.fn();
    const checkPortAvailable = vi.fn().mockResolvedValue({ ok: true });

    const result = await applyHealthyPortReuse({
      ...BASE_INPUT,
      destroyGateway,
      runOpenshell,
      checkPortAvailable,
      verifyGatewayContainerRunning: () => "missing",
    });

    expect(result).not.toBe("continue");
    expect(result).not.toBeNull();
    if (result && result !== "continue") {
      // Caller must see the downgraded reuse state even when the port frees up,
      // so downstream branches don't keep treating the runtime as healthy.
      expect(result.gatewayReuseState).toBe("missing");
      expect(result.portCheck.ok).toBe(true);
    }
    expect(destroyGateway).toHaveBeenCalledTimes(1);
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "18789"], { ignoreError: true });
    expect(checkPortAvailable).toHaveBeenCalledWith(8080, undefined);
    const messages = log.mock.calls.map((c) => c[0]);
    expect(messages).toContain(
      "  Gateway metadata is stale (container not running). Cleaning up...",
    );
    expect(messages).toContain("  ✓ Port 8080 available (OpenShell gateway)");
  });

  it("returns fall-through state when cleanup succeeds but the port is still busy", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const checkPortAvailable = vi.fn().mockResolvedValue({ ok: false });

    const result = await applyHealthyPortReuse({
      ...BASE_INPUT,
      destroyGateway: () => true,
      runOpenshell: vi.fn(),
      checkPortAvailable,
      verifyGatewayContainerRunning: () => "missing",
    });

    expect(result).not.toBeNull();
    expect(result).not.toBe("continue");
    if (result && result !== "continue") {
      expect(result.gatewayReuseState).toBe("missing");
      expect(result.portCheck.ok).toBe(false);
    }
  });

  it("logs the reuse message and continues when the container is live", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const destroyGateway = vi.fn(() => true);
    const checkPortAvailable = vi.fn();

    const result = await applyHealthyPortReuse({
      ...BASE_INPUT,
      destroyGateway,
      runOpenshell: vi.fn(),
      checkPortAvailable,
      verifyGatewayContainerRunning: () => "running",
    });

    expect(result).toBe("continue");
    expect(destroyGateway).not.toHaveBeenCalled();
    expect(checkPortAvailable).not.toHaveBeenCalled();
    const messages = log.mock.calls.map((c) => c[0]);
    expect(messages).toContain(
      "  ✓ Port 8080 already owned by healthy NemoClaw runtime (OpenShell gateway)",
    );
  });

  it("skips the container probe when lifecycle commands are unsupported", async () => {
    // Package-managed openshell builds intentionally have no openshell-cluster-*
    // container. Probing Docker would always return "missing" and the decision
    // would still come out as "reuse", so the probe is wasted work — worse, in
    // environments where the docker CLI is flaky the probe can stall onboard.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const verifyContainer = vi.fn();

    const result = await applyHealthyPortReuse({
      ...BASE_INPUT,
      supportsLifecycleCommands: false,
      destroyGateway: () => true,
      runOpenshell: vi.fn(),
      checkPortAvailable: vi.fn(),
      verifyGatewayContainerRunning: verifyContainer,
    });

    expect(result).toBe("continue");
    expect(verifyContainer).not.toHaveBeenCalled();
    const messages = log.mock.calls.map((c) => c[0]);
    expect(messages).toContain(
      "  ✓ Port 8080 already owned by healthy NemoClaw runtime (OpenShell gateway)",
    );
  });

  it("reuses the dashboard port without consulting the container", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const checkPortAvailable = vi.fn();
    const verifyContainer = vi.fn();

    const result = await applyHealthyPortReuse({
      ...BASE_INPUT,
      port: 18789,
      label: "NemoClaw dashboard",
      destroyGateway: () => true,
      runOpenshell: vi.fn(),
      checkPortAvailable,
      verifyGatewayContainerRunning: verifyContainer,
    });

    expect(result).toBe("continue");
    expect(verifyContainer).not.toHaveBeenCalled();
    expect(checkPortAvailable).not.toHaveBeenCalled();
    const messages = log.mock.calls.map((c) => c[0]);
    expect(messages).toContain(
      "  ✓ Port 18789 already owned by healthy NemoClaw runtime (NemoClaw dashboard)",
    );
  });
});
