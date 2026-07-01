// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

// Import source directly so this test cannot pass against a stale build.
import {
  confirmRecoveredSandboxGatewayManaged,
  probeSandboxInferenceGatewayHealth,
  waitForRecoveredSandboxGateway,
} from "./process-recovery";

describe("confirmRecoveredSandboxGatewayManaged scope", () => {
  const requestGatewaySupervisorAction = vi.fn(() => ({
    status: 0,
    stdout: "GATEWAY_PID=4242\n",
    stderr: "",
  }));
  const openClawEntry = {
    name: "my-sandbox",
    agent: "openclaw",
    openshellDriver: "docker",
  };

  it("accepts only an authenticated recovery marker for a built-in OpenClaw sandbox", () => {
    requestGatewaySupervisorAction.mockClear();
    expect(
      confirmRecoveredSandboxGatewayManaged("my-sandbox", {
        getSandboxImpl: () => openClawEntry,
        getSessionAgentImpl: () => null,
        requestGatewaySupervisorActionImpl: requestGatewaySupervisorAction,
      }),
    ).toBe(true);
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("my-sandbox", "probe");
  });

  it("does not control custom agents or non-direct OpenShell drivers", () => {
    requestGatewaySupervisorAction.mockClear();
    expect(
      confirmRecoveredSandboxGatewayManaged("my-sandbox", {
        getSandboxImpl: () => ({ ...openClawEntry, agent: "custom-agent" }),
        requestGatewaySupervisorActionImpl: requestGatewaySupervisorAction,
      }),
    ).toBeNull();
    expect(
      confirmRecoveredSandboxGatewayManaged("my-sandbox", {
        getSandboxImpl: () => ({ ...openClawEntry, openshellDriver: "kubernetes" }),
        requestGatewaySupervisorActionImpl: requestGatewaySupervisorAction,
      }),
    ).toBeNull();
    expect(requestGatewaySupervisorAction).not.toHaveBeenCalled();
  });

  it("does not treat an unloaded Hermes definition as OpenClaw", () => {
    requestGatewaySupervisorAction.mockClear();
    expect(
      confirmRecoveredSandboxGatewayManaged("hermes-box", {
        getSandboxImpl: () => ({ ...openClawEntry, name: "hermes-box", agent: "hermes" }),
        getSessionAgentImpl: () => null,
        requestGatewaySupervisorActionImpl: requestGatewaySupervisorAction,
      }),
    ).toBeNull();
    expect(requestGatewaySupervisorAction).not.toHaveBeenCalled();
  });

  it("allows authenticated confirmation for a loaded built-in Hermes sandbox", () => {
    requestGatewaySupervisorAction.mockClear();
    expect(
      confirmRecoveredSandboxGatewayManaged("hermes-box", {
        getSandboxImpl: () => ({ ...openClawEntry, name: "hermes-box", agent: "hermes" }),
        getSessionAgentImpl: () => ({ name: "hermes", runtime: { kind: "gateway" } }) as never,
        requestGatewaySupervisorActionImpl: requestGatewaySupervisorAction,
      }),
    ).toBe(true);
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("hermes-box", "probe");
  });

  it("rejects a marker from a failed controller action", () => {
    expect(
      confirmRecoveredSandboxGatewayManaged("my-sandbox", {
        getSandboxImpl: () => openClawEntry,
        getSessionAgentImpl: () => null,
        requestGatewaySupervisorActionImpl: () => ({
          status: 1,
          stdout: "GATEWAY_PID=4242\n",
          stderr: "GATEWAY_FAILED",
        }),
      }),
    ).toBe(false);
  });
});

describe("probeSandboxInferenceGatewayHealth gateway-chain subprobe (#3265)", () => {
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

describe("waitForRecoveredSandboxGateway settle-window confirmation (#4710)", () => {
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

  it("uses one authenticated managed probe after the settle window", () => {
    const sleeps: number[] = [];
    const managedProbe = vi.fn(() => true);
    const ordinaryProbe = vi.fn(() => false);
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      probeImpl: ordinaryProbe,
      managedProbeImpl: managedProbe,
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(true);
    expect(managedProbe).toHaveBeenCalledOnce();
    expect(ordinaryProbe).not.toHaveBeenCalled();
    expect(sleeps).toEqual([25]);
  });

  it("does not let ordinary outer-namespace health override a managed probe failure", () => {
    const sleeps: number[] = [];
    const managedProbe = vi.fn(() => false);
    const ordinaryProbe = vi.fn(() => true);
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      probeImpl: ordinaryProbe,
      managedProbeImpl: managedProbe,
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(false);
    expect(managedProbe).toHaveBeenCalledOnce();
    expect(ordinaryProbe).not.toHaveBeenCalled();
    expect(sleeps).toEqual([25]);
  });

  it("accepts the initial managed proof without another probe when settling is disabled", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";
    const managedProbe = vi.fn(() => false);
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      probeImpl: () => false,
      managedProbeImpl: managedProbe,
      sleepImpl: () => {},
    });
    expect(ok).toBe(true);
    expect(managedProbe).not.toHaveBeenCalled();
  });

  it("uses the bounded recovery window for transient stopped probes", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "6";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    const sleeps: number[] = [];
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([true, false, false, true]),
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([25, 3, 3]);
  });

  it("uses the bounded recovery window for inconclusive post-settle transport", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "6";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    const sleeps: number[] = [];
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([true, null, null, true]),
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([25, 3, 3]);
  });

  it("fails closed when post-settle transport stays inconclusive for the bounded window", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "6";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    const sleeps: number[] = [];
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([true, null]),
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(false);
    expect(sleeps).toEqual([25, 3, 3]);
  });

  it("fails recovery when the gateway serves once and then drops its listener (wedge)", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "6";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    const sleeps: number[] = [];
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      probeImpl: makeProbe([true]),
      managedProbeImpl: () => false,
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

  it("uses the manifest health timeout threaded by the recovery caller", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";
    let probes = 0;

    const ok = waitForRecoveredSandboxGateway("hermes-box", {
      probeImpl: () => {
        probes += 1;
        return false;
      },
      sleepImpl: () => {},
      timeoutSeconds: 90,
    });

    expect(ok).toBe(false);
    expect(probes).toBe(31);
  });

  it("lets the recovery wait environment override take precedence over the manifest timeout", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "6";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";
    let probes = 0;

    const ok = waitForRecoveredSandboxGateway("hermes-box", {
      probeImpl: () => {
        probes += 1;
        return false;
      },
      sleepImpl: () => {},
      timeoutSeconds: 90,
    });

    expect(ok).toBe(false);
    expect(probes).toBe(3);
  });
});
