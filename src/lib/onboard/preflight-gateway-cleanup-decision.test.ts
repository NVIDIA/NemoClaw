// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayReuseState } from "../state/gateway";

import {
  applyPreflightGatewayCleanup,
  PREFLIGHT_DEFERRED_RECREATE_MESSAGE,
  preflightGatewayCleanupDecision,
} from "./preflight-gateway-cleanup-decision";

function stubStderrColorDepth(colorDepth: number): void {
  const stderr = Object.assign(Object.create(process.stderr), {
    getColorDepth: () => colorDepth,
    isTTY: true,
  }) as typeof process.stderr;
  vi.spyOn(process, "stderr", "get").mockReturnValue(stderr);
  vi.stubEnv("NO_COLOR", "");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("preflightGatewayCleanupDecision", () => {
  it("defers when state is stale and Docker-driver gateway is enabled", () => {
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "stale",
        isDockerDriverGatewayEnabled: true,
      }),
    ).toBe("defer");
  });

  it("defers when state is active-unnamed and Docker-driver gateway is enabled", () => {
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "active-unnamed",
        isDockerDriverGatewayEnabled: true,
      }),
    ).toBe("defer");
  });

  it("destroys legacy gateway in preflight when Docker-driver gateway is not enabled", () => {
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "stale",
        isDockerDriverGatewayEnabled: false,
      }),
    ).toBe("destroy-legacy");
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "active-unnamed",
        isDockerDriverGatewayEnabled: false,
      }),
    ).toBe("destroy-legacy");
  });

  it("returns noop for non-stale states regardless of driver", () => {
    for (const state of ["healthy", "missing", "foreign-active"] as const) {
      expect(
        preflightGatewayCleanupDecision({
          gatewayReuseState: state,
          isDockerDriverGatewayEnabled: true,
        }),
      ).toBe("noop");
      expect(
        preflightGatewayCleanupDecision({
          gatewayReuseState: state,
          isDockerDriverGatewayEnabled: false,
        }),
      ).toBe("noop");
    }
  });
});

describe("applyPreflightGatewayCleanup", () => {
  function makeDeps(overrides: {
    gatewayReuseState: GatewayReuseState;
    isDockerDriverGatewayEnabled: boolean;
  }) {
    const log = vi.fn();
    const warn = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const destroyGateway = vi.fn(() => true);
    const destroyGatewayForReuse = vi.fn<
      (destroy: () => boolean, success: string, failure: string) => GatewayReuseState
    >((destroy) => {
      destroy();
      return "missing";
    });
    return {
      deps: {
        gatewayReuseState: overrides.gatewayReuseState,
        isDockerDriverGatewayEnabled: overrides.isDockerDriverGatewayEnabled,
        cliDisplayName: "NemoClaw",
        dashboardPort: 8081,
        log,
        warn,
        runOpenshell,
        destroyGateway,
        destroyGatewayForReuse,
      },
      log,
      warn,
      runOpenshell,
      destroyGateway,
      destroyGatewayForReuse,
    };
  }

  it("warns in yellow without invoking destroy on the Docker-driver path", () => {
    stubStderrColorDepth(24);
    const ctx = makeDeps({ gatewayReuseState: "stale", isDockerDriverGatewayEnabled: true });
    const next = applyPreflightGatewayCleanup(ctx.deps);
    expect(next).toBe("stale");
    expect(ctx.warn).toHaveBeenCalledWith(
      `  \x1b[33m⚠ ${PREFLIGHT_DEFERRED_RECREATE_MESSAGE}\x1b[39m`,
    );
    expect(ctx.log).not.toHaveBeenCalled();
    expect(ctx.destroyGateway).not.toHaveBeenCalled();
    expect(ctx.destroyGatewayForReuse).not.toHaveBeenCalled();
    expect(ctx.runOpenshell).not.toHaveBeenCalled();
  });

  it("prints the deferral warning without ANSI when NO_COLOR is set", () => {
    stubStderrColorDepth(24);
    vi.stubEnv("NO_COLOR", "1");
    const ctx = makeDeps({ gatewayReuseState: "stale", isDockerDriverGatewayEnabled: true });

    applyPreflightGatewayCleanup(ctx.deps);

    expect(ctx.warn).toHaveBeenCalledWith(`  ⚠ ${PREFLIGHT_DEFERRED_RECREATE_MESSAGE}`);
    expect(String(ctx.warn.mock.calls[0]?.[0])).not.toContain("\x1b[");
  });

  it("destroys the legacy gateway and stops the dashboard forward on the non-Docker-driver path", () => {
    const ctx = makeDeps({ gatewayReuseState: "stale", isDockerDriverGatewayEnabled: false });
    const next = applyPreflightGatewayCleanup(ctx.deps);
    expect(next).toBe("missing");
    expect(ctx.log).toHaveBeenCalledWith("  Cleaning up previous NemoClaw session...");
    expect(ctx.runOpenshell).toHaveBeenCalledWith(["forward", "stop", "8081"], {
      ignoreError: true,
    });
    expect(ctx.destroyGatewayForReuse).toHaveBeenCalledTimes(1);
    expect(ctx.destroyGateway).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for healthy / missing / foreign-active states", () => {
    for (const state of ["healthy", "missing", "foreign-active"] as const) {
      const ctx = makeDeps({ gatewayReuseState: state, isDockerDriverGatewayEnabled: true });
      const next = applyPreflightGatewayCleanup(ctx.deps);
      expect(next).toBe(state);
      expect(ctx.log).not.toHaveBeenCalled();
      expect(ctx.warn).not.toHaveBeenCalled();
      expect(ctx.destroyGateway).not.toHaveBeenCalled();
      expect(ctx.destroyGatewayForReuse).not.toHaveBeenCalled();
      expect(ctx.runOpenshell).not.toHaveBeenCalled();
    }
  });
});
