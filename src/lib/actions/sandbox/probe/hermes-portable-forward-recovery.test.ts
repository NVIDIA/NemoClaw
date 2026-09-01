// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ForwardServiceController } from "../../../adapters/openshell/forward-service-controller";
import {
  prepareHermesPortableLaunchForwards,
  verifyHermesPortableLaunchForwards,
  type HermesPortableForwardRecoveryInput,
} from "./hermes-portable-forward-recovery";

const authority = {
  gatewayName: "nemoclaw",
  sandboxIdentityFingerprint: "a".repeat(64),
  sandboxName: "alpha",
};

function fixture(states: Record<number, "healthy" | "missing" | "occupied">) {
  const current = new Map(Object.entries(states).map(([port, state]) => [Number(port), state]));
  const ensure = vi.fn((_authority, endpoint) => {
    current.set(endpoint.localPort, "healthy");
    return { action: "started" as const, receipt: {} as never };
  });
  const stop = vi.fn((_authority, endpoint) => {
    current.set(endpoint.localPort, "missing");
    return "stopped" as const;
  });
  const controller = {
    ensure,
    inspect: vi.fn((_authority, endpoint) => {
      const state = current.get(endpoint.localPort) ?? "missing";
      return state === "healthy"
        ? {
            disposition: "owned" as const,
            ownsListener: true,
            reachable: true,
            receipt: {} as never,
          }
        : state === "occupied"
          ? {
              disposition: "foreign" as const,
              ownsListener: false,
              reachable: true,
              receipt: {} as never,
            }
          : {
              disposition: "absent" as const,
              ownsListener: false,
              reachable: false,
              receipt: null,
            };
    }),
    stop,
    stopAll: vi.fn(() => 0),
    stopPort: vi.fn(() => "absent" as const),
  } satisfies ForwardServiceController;
  const migrateLegacy = vi.fn();
  const assertCurrent = vi.fn();
  const assertRollbackCurrent = vi.fn();
  const input: HermesPortableForwardRecoveryInput = {
    intent: "connect-probe-only",
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    operationTimeoutMs: 30_000,
    ports: Object.keys(states).map(Number),
    probeTimeoutMs: 5_000,
    deps: {
      assertCurrent,
      assertRollbackCurrent,
      authority,
      controller,
      migrateLegacy,
    },
  };
  return {
    assertCurrent,
    assertRollbackCurrent,
    controller,
    current,
    ensure,
    input,
    migrateLegacy,
    stop,
  };
}

describe("Hermes Portable ForwardTcp transaction", () => {
  it("verifies an already healthy receipt-owned set without migration", () => {
    const h = fixture({ 8642: "healthy", 18789: "healthy" });

    expect(verifyHermesPortableLaunchForwards(h.input)).toEqual({ kind: "healthy" });
    expect(h.migrateLegacy).not.toHaveBeenCalled();
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it("migrates once, starts every missing service, and can roll back exact receipts", () => {
    const h = fixture({ 8642: "missing", 18789: "healthy" });
    const prepared = prepareHermesPortableLaunchForwards(h.input);

    expect(prepared.result).toEqual({ kind: "restored", restoredPorts: [8642] });
    expect(h.migrateLegacy).toHaveBeenCalledOnce();
    expect(h.ensure).toHaveBeenCalledWith(authority, {
      localHost: "127.0.0.1",
      localPort: 8642,
      targetPort: 8642,
    });

    prepared.rollback();
    expect(h.stop).toHaveBeenCalledWith(authority, {
      localHost: "127.0.0.1",
      localPort: 8642,
      targetPort: 8642,
    });
    expect(h.current.get(8642)).toBe("missing");
  });

  it("refuses a reachable service owned outside the exact receipt authority", () => {
    const h = fixture({ 18789: "occupied" });

    expect(() => prepareHermesPortableLaunchForwards(h.input)).toThrow(/forward-occupied/u);
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it("reports authority drift before migration or process mutation", () => {
    const h = fixture({ 18789: "missing" });
    h.assertCurrent.mockImplementation(() => {
      throw new Error("drift");
    });

    expect(() => prepareHermesPortableLaunchForwards(h.input)).toThrow(/authority-drift/u);
    expect(h.migrateLegacy).not.toHaveBeenCalled();
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it("fails closed when exact rollback command authority is gone", () => {
    const h = fixture({ 18789: "missing" });
    const prepared = prepareHermesPortableLaunchForwards(h.input);
    h.assertRollbackCurrent.mockImplementation(() => {
      throw new Error("drift");
    });

    expect(() => prepared.rollback()).toThrow(/restoration-unproved/u);
    expect(h.stop).not.toHaveBeenCalled();
  });
});
