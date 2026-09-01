// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  requireForwardServiceAuthority,
  retireLegacySandboxForwards,
} from "./forward-service-migration";

const fingerprint = "a".repeat(64);

describe("ForwardTcp legacy migration", () => {
  it("publishes complete authority from the live OpenShell sandbox ID", () => {
    let current: Record<string, unknown> = {
      name: "alpha",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    };
    const compareAndSet = vi.fn((_expected, generation, liveFingerprint) => {
      current = {
        ...current,
        lifecycleGeneration: generation,
        lifecycleLiveIdentityFingerprint: liveFingerprint,
      };
      return true;
    });
    const observe = vi.fn(() => ({
      state: "ready" as const,
      liveIdentityFingerprint: fingerprint,
    }));

    const migration = requireForwardServiceAuthority("alpha", {
      compareAndSet: compareAndSet as never,
      generation: () => "generation-1",
      getSandbox: () => current as never,
      observe,
      resolveGatewayName: () => "nemoclaw",
      resolveGatewayPort: () => 8080,
    });

    expect(migration.migrated).toBe(true);
    expect(migration.authority).toEqual({
      gatewayName: "nemoclaw",
      sandboxIdentityFingerprint: fingerprint,
      sandboxName: "alpha",
    });
    expect(compareAndSet).toHaveBeenCalledOnce();
    expect(current).toMatchObject({
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: fingerprint,
    });
    expect(observe).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "alpha",
    });
  });

  it("retires only same-gateway same-sandbox legacy rows before direct service adoption", () => {
    const assertCurrent = vi.fn();
    const assertLiveCurrent = vi.fn();
    const run = vi.fn(() => ({ status: 0 }));
    const migration = {
      authority: {
        gatewayName: "nemoclaw",
        sandboxIdentityFingerprint: fingerprint,
        sandboxName: "alpha",
      },
      migrated: false,
      assertCurrent,
      assertLiveCurrent,
    };

    expect(
      retireLegacySandboxForwards(migration, {
        capture: vi.fn(() => ({
          status: 0,
          output:
            "SANDBOX BIND PORT PID STATUS\n" +
            "alpha 127.0.0.1 18789 10 running\n" +
            "beta 127.0.0.1 3978 11 running\n",
        })) as never,
        isReachable: () => false,
        run: run as never,
      }),
    ).toBe(1);
    expect(run).toHaveBeenCalledWith("nemoclaw", "alpha", 18_789);
    expect(assertLiveCurrent).toHaveBeenCalledOnce();
  });

  it("refuses mutable-name legacy cleanup after live identity drift", () => {
    const run = vi.fn();
    const migration = {
      authority: {
        gatewayName: "nemoclaw",
        sandboxIdentityFingerprint: fingerprint,
        sandboxName: "alpha",
      },
      migrated: false,
      assertCurrent: vi.fn(),
      assertLiveCurrent: vi.fn(() => {
        throw new Error("live identity changed");
      }),
    };

    expect(() =>
      retireLegacySandboxForwards(migration, {
        capture: vi.fn(() => ({
          status: 0,
          output: "SANDBOX BIND PORT PID STATUS\nalpha 127.0.0.1 18789 10 running\n",
        })) as never,
        isReachable: () => false,
        run: run as never,
      }),
    ).toThrow(/live identity changed/u);
    expect(run).not.toHaveBeenCalled();
  });
});
