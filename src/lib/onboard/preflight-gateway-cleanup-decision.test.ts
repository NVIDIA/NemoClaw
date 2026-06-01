// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { GatewayReuseState } from "../state/gateway";

import {
  PREFLIGHT_DEFERRED_RECREATE_MESSAGE,
  PREFLIGHT_LIVE_SANDBOX_REFUSAL_HEADER,
  applyPreflightGatewayCleanup,
  preflightGatewayCleanupDecision,
  runPreflightGatewayCleanup,
} from "./preflight-gateway-cleanup-decision";

describe("preflightGatewayCleanupDecision", () => {
  it("defers when state is stale, Docker-driver gateway is enabled, and no live sandboxes", () => {
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "stale",
        isDockerDriverGatewayEnabled: true,
        liveSandboxNames: [],
      }),
    ).toBe("defer");
  });

  it("defers when state is active-unnamed and no live sandboxes", () => {
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "active-unnamed",
        isDockerDriverGatewayEnabled: true,
        liveSandboxNames: [],
      }),
    ).toBe("defer");
  });

  it("refuses on confirmed drift (stale) when live sandboxes exist", () => {
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "stale",
        isDockerDriverGatewayEnabled: true,
        liveSandboxNames: ["sandbox-a"],
      }),
    ).toBe("refuse");
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "stale",
        isDockerDriverGatewayEnabled: true,
        liveSandboxNames: ["sandbox-a", "sandbox-b"],
      }),
    ).toBe("refuse");
  });

  it("defers on active-unnamed even with live sandboxes so the port-availability check can run", () => {
    // `active-unnamed` means there is an endpoint without a named-gateway
    // metadata entry; the port loop may still fail on its own (e.g. host
    // listener squatting on the configured gateway port), so deferring lets
    // that diagnostic fire instead of pre-empting with the refuse message.
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "active-unnamed",
        isDockerDriverGatewayEnabled: true,
        liveSandboxNames: ["sandbox-a"],
      }),
    ).toBe("defer");
  });

  it("destroys legacy gateway in preflight when Docker-driver gateway is not enabled", () => {
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "stale",
        isDockerDriverGatewayEnabled: false,
        liveSandboxNames: [],
      }),
    ).toBe("destroy-legacy");
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "active-unnamed",
        isDockerDriverGatewayEnabled: false,
        liveSandboxNames: [],
      }),
    ).toBe("destroy-legacy");
  });

  it("destroys legacy gateway even with live sandboxes when Docker-driver gateway is not enabled", () => {
    // Legacy package-managed gateway path is unaffected by the live-sandbox
    // guard — that path destroys/restarts the gateway process without
    // touching the openshell-cluster-* container.
    expect(
      preflightGatewayCleanupDecision({
        gatewayReuseState: "stale",
        isDockerDriverGatewayEnabled: false,
        liveSandboxNames: ["sandbox-a"],
      }),
    ).toBe("destroy-legacy");
  });

  it("returns noop for non-stale states regardless of driver or sandbox set", () => {
    for (const state of ["healthy", "missing", "foreign-active"] as const) {
      for (const liveSandboxNames of [[], ["sandbox-a"]]) {
        expect(
          preflightGatewayCleanupDecision({
            gatewayReuseState: state,
            isDockerDriverGatewayEnabled: true,
            liveSandboxNames,
          }),
        ).toBe("noop");
        expect(
          preflightGatewayCleanupDecision({
            gatewayReuseState: state,
            isDockerDriverGatewayEnabled: false,
            liveSandboxNames,
          }),
        ).toBe("noop");
      }
    }
  });
});

describe("applyPreflightGatewayCleanup", () => {
  function makeDeps(overrides: {
    gatewayReuseState: GatewayReuseState;
    isDockerDriverGatewayEnabled: boolean;
    liveSandboxNames?: readonly string[];
  }) {
    const log = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const destroyGateway = vi.fn(() => true);
    const destroyGatewayForReuse = vi.fn<
      (
        destroy: () => boolean,
        success: string,
        failure: string,
      ) => GatewayReuseState
    >((destroy) => {
      destroy();
      return "missing";
    });
    const exitProcess = vi.fn((_code: number) => {
      throw new Error("exit");
    }) as unknown as (code: number) => never;
    return {
      deps: {
        gatewayReuseState: overrides.gatewayReuseState,
        isDockerDriverGatewayEnabled: overrides.isDockerDriverGatewayEnabled,
        cliDisplayName: "NemoClaw",
        cliCommandName: "nemoclaw",
        dashboardPort: 8081,
        liveSandboxNames: overrides.liveSandboxNames ?? [],
        log,
        runOpenshell,
        destroyGateway,
        destroyGatewayForReuse,
        exitProcess,
      },
      log,
      runOpenshell,
      destroyGateway,
      destroyGatewayForReuse,
      exitProcess,
    };
  }

  it("logs the deferral notice without invoking destroy on the Docker-driver path", () => {
    const ctx = makeDeps({ gatewayReuseState: "stale", isDockerDriverGatewayEnabled: true });
    const next = applyPreflightGatewayCleanup(ctx.deps);
    expect(next).toBe("stale");
    expect(ctx.log).toHaveBeenCalledWith(PREFLIGHT_DEFERRED_RECREATE_MESSAGE);
    expect(ctx.destroyGateway).not.toHaveBeenCalled();
    expect(ctx.destroyGatewayForReuse).not.toHaveBeenCalled();
    expect(ctx.runOpenshell).not.toHaveBeenCalled();
    expect(ctx.exitProcess).not.toHaveBeenCalled();
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
    expect(ctx.exitProcess).not.toHaveBeenCalled();
  });

  it("refuses with structured guidance when a live sandbox is at risk on the Docker-driver path", () => {
    const ctx = makeDeps({
      gatewayReuseState: "stale",
      isDockerDriverGatewayEnabled: true,
      liveSandboxNames: ["sandbox-a", "sandbox-b"],
    });
    expect(() => applyPreflightGatewayCleanup(ctx.deps)).toThrow("exit");
    const logged = ctx.log.mock.calls.map(([line]) => line).join("\n");
    expect(logged).toContain(PREFLIGHT_LIVE_SANDBOX_REFUSAL_HEADER);
    expect(logged).toContain("Live sandbox(es): sandbox-a, sandbox-b");
    expect(logged).toContain("nemoclaw sandbox-a stop");
    expect(logged).toContain("nemoclaw sandbox-b stop");
    expect(logged).toContain("NEMOCLAW_GATEWAY_PORT");
    expect(logged).toContain("#3053");
    expect(ctx.exitProcess).toHaveBeenCalledWith(1);
    expect(ctx.destroyGateway).not.toHaveBeenCalled();
    expect(ctx.destroyGatewayForReuse).not.toHaveBeenCalled();
  });

  it("does not refuse the legacy non-Docker-driver path even when live sandboxes exist", () => {
    const ctx = makeDeps({
      gatewayReuseState: "stale",
      isDockerDriverGatewayEnabled: false,
      liveSandboxNames: ["sandbox-a"],
    });
    const next = applyPreflightGatewayCleanup(ctx.deps);
    expect(next).toBe("missing");
    expect(ctx.exitProcess).not.toHaveBeenCalled();
  });

  it("is a no-op for healthy / missing / foreign-active states", () => {
    for (const state of ["healthy", "missing", "foreign-active"] as const) {
      const ctx = makeDeps({ gatewayReuseState: state, isDockerDriverGatewayEnabled: true });
      const next = applyPreflightGatewayCleanup(ctx.deps);
      expect(next).toBe(state);
      expect(ctx.log).not.toHaveBeenCalled();
      expect(ctx.destroyGateway).not.toHaveBeenCalled();
      expect(ctx.destroyGatewayForReuse).not.toHaveBeenCalled();
      expect(ctx.runOpenshell).not.toHaveBeenCalled();
      expect(ctx.exitProcess).not.toHaveBeenCalled();
    }
  });
});

describe("runPreflightGatewayCleanup", () => {
  function makeDeps(overrides: {
    gatewayReuseState: GatewayReuseState;
    isDockerDriverGatewayEnabled: boolean;
    sandboxListOutput?: string;
  }) {
    const runCaptureOpenshell = vi.fn((args: string[], _opts: { ignoreError: true }) => {
      expect(args).toEqual(["sandbox", "list"]);
      return overrides.sandboxListOutput ?? "";
    });
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const destroyGateway = vi.fn(() => true);
    const destroyGatewayForReuse = vi.fn<
      (
        destroy: () => boolean,
        success: string,
        failure: string,
      ) => GatewayReuseState
    >(() => "missing");
    return {
      runCaptureOpenshell,
      runOpenshell,
      destroyGateway,
      destroyGatewayForReuse,
      deps: {
        gatewayReuseState: overrides.gatewayReuseState,
        isLinuxDockerDriverGatewayEnabled: () => overrides.isDockerDriverGatewayEnabled,
        runCaptureOpenshell,
        runOpenshell,
        cliName: () => "nemoclaw",
        cliDisplayName: () => "NemoClaw",
        destroyGateway,
        destroyGatewayForReuse,
      },
    };
  }

  it("queries sandbox list and defers when no live sandboxes exist on the Docker-driver path", () => {
    const ctx = makeDeps({
      gatewayReuseState: "stale",
      isDockerDriverGatewayEnabled: true,
      sandboxListOutput: "NAME    STATUS    AGE\nsandbox-a   Provisioning   10s\n",
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("unexpected exit");
    }) as never);
    try {
      const next = runPreflightGatewayCleanup(ctx.deps);
      expect(next).toBe("stale");
      expect(ctx.runCaptureOpenshell).toHaveBeenCalledTimes(1);
      expect(ctx.destroyGateway).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("refuses through process.exit(1) when sandbox list reports a live sandbox", () => {
    const ctx = makeDeps({
      gatewayReuseState: "stale",
      isDockerDriverGatewayEnabled: true,
      sandboxListOutput: "NAME    STATUS    AGE\nsandbox-a   Ready    5m\n",
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    try {
      expect(() => runPreflightGatewayCleanup(ctx.deps)).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(ctx.runCaptureOpenshell).toHaveBeenCalledWith(["sandbox", "list"], {
        ignoreError: true,
      });
      expect(ctx.destroyGateway).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
