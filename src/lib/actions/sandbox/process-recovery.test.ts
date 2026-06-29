// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

// Import source directly so this test cannot pass against a stale build.
import {
  probeDirectContainerGatewayHealth,
  probeRecoveredSandboxGatewayDirect,
  probeSandboxInferenceGatewayHealth,
  waitForRecoveredSandboxGateway,
} from "./process-recovery";

describe("probeDirectContainerGatewayHealth", () => {
  const directArgv = ["exec", "--user", "root", "openshell-my-sandbox", "/usr/bin/curl"];

  it("accepts only an exact successful health response through sanitized fixed argv", () => {
    const buildArgv = vi.fn(() => directArgv);
    const runDocker = vi.fn(() => ({ status: 0, stdout: "200", stderr: "" }) as never);

    expect(
      probeDirectContainerGatewayHealth("my-sandbox", "http://127.0.0.1:18789/health", {
        privilegedExecArgvImpl: buildArgv,
        dockerSpawnSyncImpl: runDocker,
      }),
    ).toBe(true);
    expect(buildArgv).toHaveBeenCalledWith(
      "my-sandbox",
      [
        "/usr/bin/curl",
        "-q",
        "--noproxy",
        "*",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "3",
        "http://127.0.0.1:18789/health",
      ],
      false,
      true,
    );
    expect(runDocker).toHaveBeenCalledWith(
      directArgv,
      expect.objectContaining({ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("rejects a healthy-looking response from a nonzero curl", () => {
    expect(
      probeDirectContainerGatewayHealth("my-sandbox", "http://localhost:8642/health", {
        privilegedExecArgvImpl: () => directArgv,
        dockerSpawnSyncImpl: () => ({ status: 1, stdout: "200", stderr: "" }) as never,
      }),
    ).toBe(false);
  });

  it("refuses non-loopback or non-HTTP probe URLs before privileged exec", () => {
    const buildArgv = vi.fn(() => directArgv);

    expect(
      probeDirectContainerGatewayHealth("my-sandbox", "https://example.com/health", {
        privilegedExecArgvImpl: buildArgv,
      }),
    ).toBeNull();
    expect(buildArgv).not.toHaveBeenCalled();
  });

  it("propagates identity and ambiguity refusals from privileged container selection", () => {
    expect(() =>
      probeDirectContainerGatewayHealth("my-sandbox", "http://127.0.0.1:18789/health", {
        privilegedExecArgvImpl: () => {
          throw new Error("ambiguous direct container identity");
        },
      }),
    ).toThrow(/ambiguous direct container identity/);
  });
});

describe("probeRecoveredSandboxGatewayDirect scope", () => {
  const directHealth = vi.fn(() => true);
  const openClawEntry = {
    name: "my-sandbox",
    agent: "openclaw",
    openshellDriver: "docker",
  };

  it("allows the tie-break for a built-in direct-driver OpenClaw sandbox", () => {
    directHealth.mockClear();
    expect(
      probeRecoveredSandboxGatewayDirect("my-sandbox", {
        getSandboxImpl: () => openClawEntry,
        getSessionAgentImpl: () => null,
        getProbeUrlImpl: () => "http://127.0.0.1:18789/health",
        directHealthImpl: directHealth,
      }),
    ).toBe(true);
    expect(directHealth).toHaveBeenCalledWith("my-sandbox", "http://127.0.0.1:18789/health");
  });

  it("does not probe custom agents or non-direct OpenShell drivers", () => {
    directHealth.mockClear();
    expect(
      probeRecoveredSandboxGatewayDirect("my-sandbox", {
        getSandboxImpl: () => ({ ...openClawEntry, agent: "custom-agent" }),
        directHealthImpl: directHealth,
      }),
    ).toBeNull();
    expect(
      probeRecoveredSandboxGatewayDirect("my-sandbox", {
        getSandboxImpl: () => ({ ...openClawEntry, openshellDriver: "kubernetes" }),
        directHealthImpl: directHealth,
      }),
    ).toBeNull();
    expect(directHealth).not.toHaveBeenCalled();
  });

  it("does not treat an unloaded Hermes definition as OpenClaw", () => {
    directHealth.mockClear();
    expect(
      probeRecoveredSandboxGatewayDirect("hermes-box", {
        getSandboxImpl: () => ({ ...openClawEntry, name: "hermes-box", agent: "hermes" }),
        getSessionAgentImpl: () => null,
        directHealthImpl: directHealth,
      }),
    ).toBeNull();
    expect(directHealth).not.toHaveBeenCalled();
  });

  it("allows the tie-break for a loaded built-in Hermes direct-driver sandbox", () => {
    directHealth.mockClear();
    expect(
      probeRecoveredSandboxGatewayDirect("hermes-box", {
        getSandboxImpl: () => ({ ...openClawEntry, name: "hermes-box", agent: "hermes" }),
        getSessionAgentImpl: () => ({ name: "hermes", runtime: { kind: "gateway" } }) as never,
        getProbeUrlImpl: () => "http://localhost:8642/health",
        directHealthImpl: directHealth,
      }),
    ).toBe(true);
    expect(directHealth).toHaveBeenCalledWith("hermes-box", "http://localhost:8642/health");
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

  it("reconciles stale stopped state through direct health only inside recovery waiting", () => {
    const sleeps: number[] = [];
    const directProbe = vi.fn(() => true);
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([false, true]),
      directProbeImpl: directProbe,
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(true);
    expect(directProbe).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([25]);
  });

  it("uses direct health to reconcile a stale post-settle stopped result", () => {
    const sleeps: number[] = [];
    const directProbe = vi.fn(() => true);
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([true, false]),
      directProbeImpl: directProbe,
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(true);
    expect(directProbe).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([25]);
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
      probeImpl: makeProbe([true, false, false]),
      directProbeImpl: () => false,
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(false);
    expect(sleeps).toEqual([25, 3, 3]);
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
