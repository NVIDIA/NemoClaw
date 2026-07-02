// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { verifySandboxBridgeGatewayReachableOrExit } from "./gateway-sandbox-reachability";

describe("verifySandboxBridgeGatewayReachableOrExit onUnreachable cleanup (#5513)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // host_gateway route so the UFW auto-apply branch (bridge_gateway only) is skipped.
  const unreachable = {
    ok: false as const,
    reason: "tcp_failed" as const,
    routeKind: "host_gateway" as const,
    networkName: "openshell-docker",
  };

  it("invokes onUnreachable before aborting on a genuine unreachable probe", async () => {
    const onUnreachable = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      verifySandboxBridgeGatewayReachableOrExit(false, {
        reachabilityImpl: () => unreachable,
        onUnreachable,
        retryAttempts: 1,
      }),
    ).rejects.toThrow("sandbox-bridge unreachable");
    expect(onUnreachable).toHaveBeenCalledTimes(1);
  });

  it("invokes onUnreachable before process.exit on the production fatal path", async () => {
    const calls: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      calls.push(`exit:${String(code ?? 0)}`);
      throw new Error(`process.exit(${String(code ?? 0)})`);
    }) as never);

    await expect(
      verifySandboxBridgeGatewayReachableOrExit(true, {
        reachabilityImpl: () => unreachable,
        onUnreachable: () => void calls.push("cleanup"),
        retryAttempts: 1,
      }),
    ).rejects.toThrow("process.exit(1)");

    expect(calls).toEqual(["cleanup", "exit:1"]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledOnce();
  });

  it("attaches cleanup failure as cause without masking the fatal probe failure", async () => {
    const cleanupError = new Error("cleanup failed");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
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
  });

  it("attaches async cleanup rejection as cause without masking the fatal probe failure", async () => {
    const cleanupError = new Error("async cleanup failed");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await verifySandboxBridgeGatewayReachableOrExit(false, {
      reachabilityImpl: () => ({ ...unreachable, reason: "probe_unavailable" }),
      onUnreachable,
    });
    expect(onUnreachable).not.toHaveBeenCalled();
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
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      verifySandboxBridgeGatewayReachableOrExit(false, {
        autoApplyImpl: () => ({ applied: true, reason: "applied" }),
        autoApplyOptedInImpl: () => true,
        onUnreachable,
        reachabilityImpl: vi.fn().mockResolvedValue(bridgeFailure),
      }),
    ).rejects.toThrow("sandbox-bridge unreachable");
    expect(onUnreachable).toHaveBeenCalledTimes(1);
  });
});
