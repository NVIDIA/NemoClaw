// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, it, expect } from "vitest";

// Import from compiled dist for parity with the other CLI tests in this project.
import {
  probeSandboxInferenceGatewayHealth,
  waitForRecoveredSandboxGateway,
} from "../../../../dist/lib/actions/sandbox/process-recovery";

describe("probeSandboxInferenceGatewayHealth — #3265 gateway-chain subprobe", () => {
  const makeExec =
    (stdout: string, status = 0) =>
    async () => ({ status, stdout, stderr: "" });

  it("reports healthy on any HTTP response (including 401) because the routing chain is up", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      execImpl: makeExec("200"),
    });
    expect(result?.ok).toBe(true);
    expect(result?.httpStatus).toBe(200);
    expect(result?.endpoint).toBe("https://inference.local/v1/models");
    expect(result?.detail).toContain("HTTP 200");
    expect(result?.detail).toContain("full chain reachable");
  });

  it("treats 401 as routing-OK (auth wall reached means the chain works)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      execImpl: makeExec("401"),
    });
    expect(result?.ok).toBe(true);
    expect(result?.httpStatus).toBe(401);
  });

  it("reports unreachable when curl returns 000 (DNS or connection refused)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      execImpl: makeExec("000"),
    });
    expect(result?.ok).toBe(false);
    expect(result?.httpStatus).toBe(0);
    expect(result?.detail).toContain("unreachable");
    expect(result?.detail).toContain("https://inference.local/v1/models");
  });

  it("returns null when the sandbox exec itself fails (probe unavailable, omit the line)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      execImpl: async () => null,
    });
    expect(result).toBeNull();
  });

  it("returns null when exec returns a non-zero status (sandbox unreachable or stopped)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      execImpl: makeExec("000", 127),
    });
    expect(result).toBeNull();
  });
});

describe("waitForRecoveredSandboxGateway — #4710 settle-window confirm", () => {
  const ENV_KEYS = [
    "NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS",
    "NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS",
    "NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS",
  ];
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // A probe whose answers play out in order; the last answer repeats.
  const makeProbe = (answers: Array<boolean | null>) => {
    const remaining = [...answers];
    return () => (remaining.length > 1 ? remaining.shift() : remaining[0]) ?? null;
  };

  it("confirms the gateway is still serving after the settle window", () => {
    const sleeps: number[] = [];
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([true, true]),
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(true);
    // Default settle window of 25s between the two probes.
    expect(sleeps).toEqual([25]);
  });

  it("fails recovery when the gateway serves once and then drops its listener (wedge)", () => {
    const sleeps: number[] = [];
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([true, false]),
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(false);
    expect(sleeps).toEqual([25]);
  });

  it("skips the settle confirm when NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS=0", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";
    const sleeps: number[] = [];
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      // A second probe would report the wedge; with the settle disabled the
      // first success must win and no second probe may run.
      probeImpl: makeProbe([true, false]),
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it("still polls through initial failures before reaching the settle confirm", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "5";
    const sleeps: number[] = [];
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([false, false, true, true]),
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(true);
    // Two poll intervals (default 3s) before the first success, then the
    // settle window.
    expect(sleeps).toEqual([3, 3, 5]);
  });

  it("returns false when the gateway never serves within the wait budget", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "0";
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([false]),
      sleepImpl: () => {},
    });
    expect(ok).toBe(false);
  });
});
