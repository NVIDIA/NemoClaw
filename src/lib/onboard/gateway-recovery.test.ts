// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { type GatewayRecoveryDeps, startGatewayForRecovery } from "./gateway-recovery";

// #3768: with the loop now purely deadline-driven, `waitUntilAsync` needs a
// clock reader. Rather than using vi.useFakeTimers (which globally patches
// timers and can hang async code), pair a captured virtual clock with the
// injected `sleepSeconds` mock so the clock advances only when the loop
// actually sleeps. Tests get deterministic deadline expiration without any
// real wall-clock waits or global timer state.
//
// `advance` is exposed so a test can also account for time spent inside a
// mocked probe. `elapsedMs` lets the timeout test observe that the complete
// configured deadline was consumed without depending on an internal call
// count or the number of OpenShell observations in one recovery probe.
function makeVirtualClock(startMs = 1_000_000_000_000) {
  let now = startMs;
  return {
    now: () => now,
    elapsedMs: () => now - startMs,
    advance: (seconds: number) => {
      now += Math.max(0, seconds) * 1000;
    },
    sleeper: vi.fn((seconds: number) => {
      now += Math.max(0, seconds) * 1000;
    }),
  };
}

function createDeps(overrides: Partial<GatewayRecoveryDeps> = {}): GatewayRecoveryDeps {
  const clock = makeVirtualClock();
  return {
    assertGatewayStartAllowed: vi.fn(),
    getGatewayClusterContainerState: () => "missing",
    runCaptureOpenshell: vi.fn(() => "Disconnected"),
    runOpenshell: vi.fn(() => ({ status: 0 })),
    getContainerRuntime: () => "docker",
    sleepSeconds: clock.sleeper,
    now: clock.now,
    startGatewayWithOptions: vi.fn(
      async () => undefined,
    ) as GatewayRecoveryDeps["startGatewayWithOptions"],
    shouldPatchCoredns: () => false,
    // Tests assert the plain-CLI fallback path by default; the Linux
    // Docker-driver branch is opted into explicitly per case.
    isLinuxDockerDriverGatewayEnabled: () => false,
    ...overrides,
  };
}

describe("gateway recovery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.OPENSHELL_GATEWAY;
  });

  it("uses the default gateway starter when no explicit target is supplied", async () => {
    const deps = createDeps();

    await startGatewayForRecovery({}, deps);

    expect(deps.startGatewayWithOptions).toHaveBeenCalledWith(undefined, {
      exitOnFailure: false,
    });
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("starts and selects the named gateway using the port encoded in its name", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "1");
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayName: "nemoclaw-8090" }, deps)).rejects.toThrow(
      "Gateway 'nemoclaw-8090' did not become ready",
    );

    expect(deps.startGatewayWithOptions).not.toHaveBeenCalled();
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(1, ["gateway", "select", "nemoclaw-8090"], {
      ignoreError: true,
    });
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["gateway", "start"]),
      expect.anything(),
    );
  });

  it("derives the canonical gateway name when only a non-default port is supplied", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "1");
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayPort: 8091 }, deps)).rejects.toThrow(
      "Gateway 'nemoclaw-8091' did not become ready",
    );

    expect(deps.runOpenshell).toHaveBeenNthCalledWith(1, ["gateway", "select", "nemoclaw-8091"], {
      ignoreError: true,
    });
  });

  it("polls until the configured recovery deadline and reports it in the timeout (#3768)", async () => {
    // #3768: prove the loop consumes its configured wall-clock deadline.
    // Account for one second of work only when the externally visible
    // status probe begins; the other OpenShell observations remain free to
    // change without changing this test's oracle.
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "10");
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_INTERVAL", "1");
    const clock = makeVirtualClock();
    const statusProbe = vi.fn(() => {
      clock.advance(1);
      return "Disconnected";
    });
    const deps = createDeps({
      sleepSeconds: clock.sleeper,
      now: clock.now,
      runCaptureOpenshell: vi.fn((argv) =>
        argv[0] === "status" ? statusProbe() : "Disconnected",
      ),
    });

    await expect(startGatewayForRecovery({ gatewayPort: 8091 }, deps)).rejects.toThrow(
      "configured 10s recovery deadline (1s poll interval)",
    );

    expect(statusProbe).toHaveBeenCalled();
    expect(clock.elapsedMs()).toBe(10_000);
    expect(clock.sleeper).toHaveBeenCalled();
    expect(clock.sleeper).toHaveBeenNthCalledWith(1, 0.25);
    expect(clock.sleeper.mock.calls.every(([s]) => s <= 1)).toBe(true);
  });

  it("succeeds on the first healthy probe without sleeping and sets OPENSHELL_GATEWAY (#3768)", async () => {
    // Advisor: pin the happy path so a future refactor cannot silently
    // break the side effects the caller relies on after readiness.
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "3");
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_INTERVAL", "2");
    const clock = makeVirtualClock();
    const deps = createDeps({
      sleepSeconds: clock.sleeper,
      now: clock.now,
      runCaptureOpenshell: vi.fn(() => "Connected"),
      isGatewayHealthy: () => true,
      isGatewayHttpReady: async () => true,
    });

    await startGatewayForRecovery({ gatewayPort: 8091 }, deps);

    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-8091");
    expect(deps.sleepSeconds).not.toHaveBeenCalled();
  });

  it("succeeds after retrying past unhealthy probes and still sets OPENSHELL_GATEWAY (#3768)", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "3");
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_INTERVAL", "2");
    // Probe #1 fails the health predicate, probe #2 passes. Each probe
    // reads status + gateway info -g + gateway info (3 calls).
    let healthCalls = 0;
    const clock = makeVirtualClock();
    const deps = createDeps({
      sleepSeconds: clock.sleeper,
      now: clock.now,
      runCaptureOpenshell: vi.fn(() => "Connected"),
      isGatewayHealthy: () => {
        healthCalls++;
        return healthCalls > 1;
      },
      isGatewayHttpReady: async () => true,
    });

    await startGatewayForRecovery({ gatewayPort: 8091 }, deps);

    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-8091");
    expect(deps.sleepSeconds).toHaveBeenCalledTimes(1);
    expect(deps.sleepSeconds).toHaveBeenNthCalledWith(1, 0.25);
  });

  it("with NEMOCLAW_HEALTH_POLL_COUNT=0 fails fast without silently claiming healthy (#3768)", async () => {
    // Edge case: a zero-count budget must not silently pretend the gateway
    // is healthy. The wait-budget helper clamps to a 1ms deadline, so
    // waitUntilAsync's first deadline check terminates before the probe
    // callback runs. Function throws with a deadline message instead of
    // returning success.
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "0");
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_INTERVAL", "2");
    const deps = createDeps({ sleepSeconds: vi.fn() });

    await expect(startGatewayForRecovery({ gatewayPort: 8091 }, deps)).rejects.toThrow(
      /did not become ready within the configured .* recovery deadline/,
    );

    expect(deps.runCaptureOpenshell).not.toHaveBeenCalled();
    expect(deps.sleepSeconds).not.toHaveBeenCalled();
  });

  it("reports legacy zero-interval recovery as immediate probes", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "3");
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_INTERVAL", "0");
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayPort: 8091 }, deps)).rejects.toThrow(
      "did not become ready within the configured 3 immediate health probes",
    );

    expect(deps.runCaptureOpenshell).toHaveBeenCalledTimes(9);
    expect(deps.sleepSeconds).toHaveBeenCalledTimes(2);
    expect(deps.sleepSeconds).toHaveBeenNthCalledWith(1, 0);
    expect(deps.sleepSeconds).toHaveBeenNthCalledWith(2, 0);
  });

  it("uses the shared extended health configuration for an existing gateway container (#10652)", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "1");
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_INTERVAL", "0");
    vi.stubEnv("NEMOCLAW_GATEWAY_START_POLL_COUNT", "3");
    vi.stubEnv("NEMOCLAW_GATEWAY_START_POLL_INTERVAL", "0");
    const deps = createDeps({ getGatewayClusterContainerState: () => "running starting" });

    await expect(startGatewayForRecovery({ gatewayPort: 8091 }, deps)).rejects.toThrow(
      "did not become ready within the configured 3 immediate health probes",
    );

    expect(deps.runCaptureOpenshell).toHaveBeenCalledTimes(9);
    expect(deps.sleepSeconds).toHaveBeenCalledTimes(2);
  });

  it("rejects non-canonical gateway recovery names before invoking OpenShell", async () => {
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayName: "other-gateway" }, deps)).rejects.toThrow(
      "Invalid NemoClaw gateway name 'other-gateway'",
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects a gateway name and port mismatch before invoking OpenShell", async () => {
    const deps = createDeps();

    await expect(
      startGatewayForRecovery({ gatewayName: "nemoclaw-8090", gatewayPort: 8091 }, deps),
    ).rejects.toThrow("Gateway 'nemoclaw-8090' does not match port 8091");

    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects privileged recovery ports before invoking OpenShell", async () => {
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayName: "nemoclaw-80" }, deps)).rejects.toThrow(
      "Invalid gateway recovery port 80",
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects the OpenRouter Runtime adapter port before invoking OpenShell (#5826)", async () => {
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayPort: 11437 }, deps)).rejects.toThrow(
      "OpenRouter Runtime adapter",
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("fails closed on cross-port recovery when the Linux Docker-driver gateway is enabled", async () => {
    const deps = createDeps({ isLinuxDockerDriverGatewayEnabled: () => true });

    await expect(startGatewayForRecovery({ gatewayName: "nemoclaw-8090" }, deps)).rejects.toThrow(
      /Cross-port recovery for Linux Docker-driver gateway 'nemoclaw-8090' is not safe/,
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(deps.startGatewayWithOptions).not.toHaveBeenCalled();
  });
});

describe("gateway lifecycle authority during recovery", () => {
  it("starts no gateway on any recovery branch when an external supervisor owns it (#6576)", async () => {
    const ownershipError = new Error("owned by openshell-gateway.service");
    const deps = createDeps({
      assertGatewayStartAllowed: vi.fn(() => {
        throw ownershipError;
      }),
    });

    // The cross-port, non-default-name target is the branch that reselects the
    // gateway without going through startGatewayWithOptions.
    await expect(
      startGatewayForRecovery({ gatewayName: "nemoclaw-8090", gatewayPort: 8090 }, deps),
    ).rejects.toThrow(ownershipError);

    expect(deps.assertGatewayStartAllowed).toHaveBeenCalledWith(false, {
      gatewayName: "nemoclaw-8090",
      gatewayPort: 8090,
    });
    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(deps.startGatewayWithOptions).not.toHaveBeenCalled();
  });

  it("still recovers normally when NemoClaw owns the gateway lifecycle (#6576)", async () => {
    const deps = createDeps({ assertGatewayStartAllowed: vi.fn() });

    await startGatewayForRecovery({}, deps);

    expect(deps.assertGatewayStartAllowed).toHaveBeenCalledWith(false, {
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });
    expect(deps.startGatewayWithOptions).toHaveBeenCalledOnce();
  });
});
