// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { verifySandboxBridgeGatewayReachableOrExit } from "./gateway-sandbox-reachability";

describe("verifySandboxBridgeGatewayReachableOrExit onUnreachable cleanup (#5513)", () => {
  // host_gateway route so the UFW auto-apply branch (bridge_gateway only) is skipped.
  const unreachable = {
    ok: false as const,
    reason: "tcp_failed" as const,
    routeKind: "host_gateway" as const,
    networkName: "openshell-docker",
  };

  it("invokes onUnreachable before aborting on a genuine unreachable probe", async () => {
    const onUnreachable = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      verifySandboxBridgeGatewayReachableOrExit(false, {
        reachabilityImpl: () => unreachable,
        onUnreachable,
        retryAttempts: 1,
      }),
    ).rejects.toThrow("sandbox-bridge unreachable");
    expect(onUnreachable).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("attaches cleanup failure as cause without masking the fatal probe failure", async () => {
    const cleanupError = new Error("cleanup failed");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      verifySandboxBridgeGatewayReachableOrExit(false, {
        reachabilityImpl: () => unreachable,
        onUnreachable: () => {
          throw cleanupError;
        },
        retryAttempts: 1,
      }),
    ).rejects.toMatchObject({
      cause: cleanupError,
      message: expect.stringContaining("sandbox-bridge unreachable"),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Gateway cleanup after sandbox-bridge failure failed: cleanup failed",
      ),
    );
    error.mockRestore();
    warn.mockRestore();
  });

  it("attaches async cleanup rejection as cause without masking the fatal probe failure", async () => {
    const cleanupError = new Error("async cleanup failed");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      verifySandboxBridgeGatewayReachableOrExit(false, {
        reachabilityImpl: () => unreachable,
        onUnreachable: async () => {
          throw cleanupError;
        },
        retryAttempts: 1,
      }),
    ).rejects.toMatchObject({
      cause: cleanupError,
      message: expect.stringContaining("sandbox-bridge unreachable"),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Gateway cleanup after sandbox-bridge failure failed: async cleanup failed",
      ),
    );
    error.mockRestore();
    warn.mockRestore();
  });

  it("does not invoke onUnreachable when the probe succeeds", async () => {
    const onUnreachable = vi.fn();
    await verifySandboxBridgeGatewayReachableOrExit(false, {
      reachabilityImpl: () => ({ ...unreachable, ok: true, reason: "ok" }),
      onUnreachable,
    });
    expect(onUnreachable).not.toHaveBeenCalled();
  });

  it("does not invoke onUnreachable for a soft probe_unavailable result", async () => {
    const onUnreachable = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await verifySandboxBridgeGatewayReachableOrExit(false, {
      reachabilityImpl: () => ({ ...unreachable, reason: "probe_unavailable" }),
      onUnreachable,
    });
    expect(onUnreachable).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("invokes onUnreachable after UFW auto-apply re-probe still fails", async () => {
    const bridgeFailure = {
      ok: false as const,
      reason: "tcp_failed" as const,
      routeKind: "bridge_gateway" as const,
      networkName: "openshell-docker",
      subnet: "172.18.0.0/16",
      gatewayIp: "172.18.0.1",
    };
    const onUnreachable = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      verifySandboxBridgeGatewayReachableOrExit(false, {
        autoApplyImpl: () => ({ applied: true, reason: "applied" }),
        autoApplyOptedInImpl: () => true,
        onUnreachable,
        reachabilityImpl: vi.fn().mockResolvedValue(bridgeFailure),
      }),
    ).rejects.toThrow("sandbox-bridge unreachable");
    expect(onUnreachable).toHaveBeenCalledTimes(1);
    error.mockRestore();
    log.mockRestore();
  });
});
