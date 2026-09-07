// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OpenShellSandboxBufferedCommandCompletion,
  OpenShellSandboxBufferedCommandExecutor,
} from "../../adapters/openshell/sandbox-command";
import { parseManagedGatewayControlCompletion } from "./gateway-restart";
// Import source directly so this test cannot pass against a stale build.
import {
  confirmRecoveredSandboxGatewayManaged,
  waitForRecoveredSandboxGateway,
  waitForRecreatedSandboxOpenShellReady,
} from "./process-recovery";

const OPENSHELL_SANDBOX_NOT_READY_STDERR = `Error:   × code: 'The system is not in a state required for the operation's
  │ execution', message: "sandbox is not ready"
`;
const OPENSHELL_SUPERVISOR_NOT_CONNECTED_STDERR = `Error:   × code: 'The service is currently unavailable', message: "supervisor
  │ relay failed: status: Unavailable, message: \\"supervisor session not
  │ connected\\", details: [], metadata: MetadataMap { headers: {} }"
`;
const OPENSHELL_SUPERVISOR_DISCONNECTED_STDERR = `Error:   × code: 'The service is currently unavailable', message: "supervisor
  │ relay failed: status: Unavailable, message: \\"supervisor session
  │ disconnected\\", details: [], metadata: MetadataMap { headers: {} }"
`;
const OPENSHELL_RELAY_OPEN_TIMED_OUT_STDERR = `Error:   × status: DeadlineExceeded, message: "relay
  │ open timed out", details: [], metadata: MetadataMap { headers: {} }
`;
const OPENSHELL_SUPERVISOR_RELAY_CHANNEL_TIMED_OUT_STDERR = `Error:   × code: 'The service is currently unavailable', message: "supervisor
  │ relay failed: status: DeadlineExceeded, message: \\"relay channel timed
  │ out\\", details: [], metadata: MetadataMap { headers: {} }"
`;
const OPENSHELL_RELAY_CHANNEL_DROPPED_STDERR = `Error:   × status: Unavailable, message: "relay
  │ channel dropped", details: [], metadata: MetadataMap { headers: {} }
`;
const OPENSHELL_RELAY_TARGET_NOT_FOUND_STDERR = `Error:   × code: 'The service is currently unavailable', message: "No such file
  │ or directory (os error 2)"
`;
const OPENSHELL_RELAY_TARGET_REFUSED_STDERR = `Error:   × code: 'The service is currently unavailable', message: "Connection
  │ refused (os error 111)"
`;
const OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR =
  "Error: sandbox 'recreated-box' is not ready (phase: Error); wait for it to reach Ready state.\n";

function completed(
  exitCode: number,
  stderr = "",
  stdout = "",
): OpenShellSandboxBufferedCommandCompletion {
  return { outcome: { kind: "completed", exitCode }, stdout, stderr };
}

function timedOut(): OpenShellSandboxBufferedCommandCompletion {
  return {
    outcome: { kind: "failed", error: { kind: "timeout", message: "timed out" } },
    stdout: "",
    stderr: "",
  };
}

function sequencedExecutor(
  first: OpenShellSandboxBufferedCommandCompletion,
  ...remaining: OpenShellSandboxBufferedCommandCompletion[]
): OpenShellSandboxBufferedCommandExecutor & { runBuffered: ReturnType<typeof vi.fn> } {
  const results = [first, ...remaining];
  let index = 0;
  const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(async () => {
    const result = results[Math.min(index, results.length - 1)] ?? first;
    index += 1;
    return result;
  });
  return { runBuffered };
}

describe("managed gateway control completion", () => {
  const nonce = "a".repeat(64);

  it.each([
    ["ok", 0, 4242],
    ["ok", 4242, 4242],
    ["already-running", 4242, 4242],
    ["already-running", 4242, 5252],
  ] as const)(
    "preserves the exact %s controller disposition (#7919)",
    (disposition, oldPid, newPid) => {
      expect(
        parseManagedGatewayControlCompletion({
          status: 0,
          stdout: `v1 ${nonce} complete ${disposition} ${oldPid} ${newPid}\nGATEWAY_PID=${newPid}`,
          stderr: "",
        }),
      ).toEqual({ disposition, oldPid, newPid });
    },
  );

  it.each([
    [`v1 ${nonce} complete already-running 4242 4242\nGATEWAY_PID=5252`, ""],
    [`v1 ${nonce} complete ok 0 4242\nGATEWAY_PID=4242\nextra`, ""],
    [`v1 ${nonce} complete changed 0 4242\nGATEWAY_PID=4242`, ""],
    [`v1 ${nonce} complete ok 0 9007199254740992\nGATEWAY_PID=9007199254740992`, ""],
    [`v1 ${nonce} complete ok 0 4242\nGATEWAY_PID=4242`, "unexpected warning"],
    ["GATEWAY_PID=4242", ""],
  ])("rejects malformed or unstructured controller output (#7919)", (stdout, stderr) => {
    expect(parseManagedGatewayControlCompletion({ status: 0, stdout, stderr })).toBeNull();
  });
});

describe("recreated sandbox OpenShell readiness", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("retries the structured not-ready state until OpenShell accepts the sandbox", async () => {
    const notReady = completed(1, OPENSHELL_SANDBOX_NOT_READY_STDERR);
    const commandExecutor = sequencedExecutor(notReady, notReady, completed(0));
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(true);
    expect(commandExecutor.runBuffered).toHaveBeenCalledTimes(3);
    expect(commandExecutor.runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "recreated-box",
        target: { kind: "selected" },
        command: ["true"],
        timeoutMilliseconds: expect.any(Number),
      }),
    );
    expect(beforeProbe).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([3, 3]);
  });

  it("retries the same-sandbox Error phase until OpenShell accepts the sandbox", async () => {
    const commandExecutor = sequencedExecutor(
      completed(1, OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR),
      completed(0),
    );
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(commandExecutor.runBuffered).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3]);
  });

  it("retries the exact same-sandbox Error phase when OpenShell also emits informational stdout", async () => {
    const commandExecutor = sequencedExecutor(
      completed(1, OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR, "Waiting for sandbox registration\n"),
      completed(0),
    );
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe: () => true,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(true);
    expect(commandExecutor.runBuffered).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3]);
  });

  it("keeps an empty read-only probe inconclusive after exact replacement re-registration", async () => {
    const commandExecutor = sequencedExecutor(
      completed(1, OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR),
      completed(1),
      completed(0),
    );
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(3);
    expect(commandExecutor.runBuffered).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([3, 3]);
  });

  it("keeps an empty first OpenShell failure terminal", async () => {
    const commandExecutor = sequencedExecutor(completed(1));
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe: () => true,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(false);
    expect(commandExecutor.runBuffered).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([]);
  });

  it("rides out a transient Error phase past the old 30s budget by default (#7227)", async () => {
    // No timeoutSeconds option and no env override: the default recovery budget
    // must be large enough (120s, aligned with connect's readiness wait) to keep
    // retrying a cold-start phase:Error settling window that exceeds the old
    // 30s / 11-attempt budget. The 12th probe (past the old 11-attempt cap) must
    // still be reached, so the primary dashboard/API forward is not abandoned.
    delete process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS;
    const errorPhase = completed(1, OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR);
    const commandExecutor = sequencedExecutor(
      errorPhase,
      ...Array.from({ length: 10 }, () => errorPhase),
      completed(0),
    );

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe: () => true,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: () => {},
        // no timeoutSeconds -> exercise the default budget; the old 30s default
        // capped at 11 attempts and would have given up before the 12th probe.
      }),
    ).toBe(true);
    expect(commandExecutor.runBuffered).toHaveBeenCalledTimes(12);
  });

  it("retries the exact supervisor reconnect states exposed during direct recreation", async () => {
    const reconnecting = [
      OPENSHELL_SUPERVISOR_NOT_CONNECTED_STDERR,
      OPENSHELL_SUPERVISOR_DISCONNECTED_STDERR,
    ].map((stderr) => completed(1, stderr));
    const commandExecutor = sequencedExecutor(reconnecting[0], reconnecting[1], completed(0));
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(true);
    expect(commandExecutor.runBuffered).toHaveBeenCalledTimes(3);
    expect(beforeProbe).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([3, 3]);
  });

  it.each([
    OPENSHELL_RELAY_OPEN_TIMED_OUT_STDERR,
    OPENSHELL_SUPERVISOR_RELAY_CHANNEL_TIMED_OUT_STDERR,
  ])(
    "retries when the connected supervisor misses OpenShell's relay deadline (#7227)",
    async (stderr) => {
      const commandExecutor = sequencedExecutor(completed(1, stderr), completed(0));
      const beforeProbe = vi.fn(() => true);
      const sleeps: number[] = [];

      expect(
        await waitForRecreatedSandboxOpenShellReady("recreated-box", {
          beforeProbe,
          commandExecutor,
          intervalSeconds: 3,
          sleepImpl: (seconds) => sleeps.push(seconds),
          timeoutSeconds: 30,
        }),
      ).toBe(true);
      expect(beforeProbe).toHaveBeenCalledTimes(2);
      expect(commandExecutor.runBuffered).toHaveBeenCalledTimes(2);
      expect(sleeps).toEqual([3]);
    },
  );

  it("retries when OpenShell drops the replacement supervisor's reverse relay", async () => {
    const commandExecutor = sequencedExecutor(
      completed(1, OPENSHELL_RELAY_CHANNEL_DROPPED_STDERR),
      completed(0),
    );
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(commandExecutor.runBuffered).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3]);
  });

  it.each([OPENSHELL_RELAY_TARGET_NOT_FOUND_STDERR, OPENSHELL_RELAY_TARGET_REFUSED_STDERR])(
    "retries while the replacement supervisor's local relay target starts (#7273)",
    async (stderr) => {
      const commandExecutor = sequencedExecutor(completed(1, stderr), completed(0));
      const beforeProbe = vi.fn(() => true);
      const sleeps: number[] = [];

      expect(
        await waitForRecreatedSandboxOpenShellReady("recreated-box", {
          beforeProbe,
          commandExecutor,
          intervalSeconds: 3,
          sleepImpl: (seconds) => sleeps.push(seconds),
          timeoutSeconds: 30,
        }),
      ).toBe(true);
      expect(beforeProbe).toHaveBeenCalledTimes(2);
      expect(commandExecutor.runBuffered).toHaveBeenCalledTimes(2);
      expect(sleeps).toEqual([3]);
    },
  );

  it.each([
    `Error:   × status: DeadlineExceeded, message: "policy update timed out"`,
    `Error:   × code: 'The service is currently unavailable', message: "supervisor
  │ relay failed: status: DeadlineExceeded, message: \\"relay requester timed
  │ out\\", details: [], metadata: MetadataMap { headers: {} }"`,
    `Error:   × code: 'The service is currently unavailable', message: "permission denied"`,
    "Error: sandbox 'other-box' is not ready (phase: Error); wait for it to reach Ready state.",
    "Error: sandbox 'recreated-box' is not ready (phase: Failed); wait for it to reach Ready state.",
  ])("does not retry an unrelated OpenShell error", async (stderr) => {
    const commandExecutor = sequencedExecutor(completed(1, stderr));
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(false);
    expect(commandExecutor.runBuffered).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([]);
  });

  it("fails immediately on an unknown OpenShell error", async () => {
    const commandExecutor = sequencedExecutor(completed(1, "permission denied"));
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(false);
    expect(commandExecutor.runBuffered).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([]);
  });

  it("retries the no-op OpenShell readiness probe after a command timeout (#7273)", async () => {
    const commandExecutor = sequencedExecutor(timedOut(), completed(0));
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(commandExecutor.runBuffered).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3]);
  });

  it("rechecks the pinned managed guard before every readiness retry", async () => {
    const commandExecutor = sequencedExecutor(completed(1, OPENSHELL_SANDBOX_NOT_READY_STDERR));
    const beforeProbe = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(false);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(commandExecutor.runBuffered).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([3]);
  });

  it("retries an inconclusive managed guard within the readiness deadline", async () => {
    const commandExecutor = sequencedExecutor(completed(0));
    const beforeProbe = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(true);
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(commandExecutor.runBuffered).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([3]);
  });

  it("fails closed on a definitive managed guard failure without probing OpenShell", async () => {
    const commandExecutor = sequencedExecutor(completed(0));
    const beforeProbe = vi.fn(() => false);
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(false);
    expect(beforeProbe).toHaveBeenCalledOnce();
    expect(commandExecutor.runBuffered).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it("fails when the managed guard stays inconclusive until the deadline", async () => {
    const commandExecutor = sequencedExecutor(completed(0));
    const beforeProbe = vi.fn(() => null);
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(false);
    expect(beforeProbe).toHaveBeenCalledTimes(3);
    expect(commandExecutor.runBuffered).not.toHaveBeenCalled();
    expect(sleeps).toEqual([3, 3]);
  });

  it("lets the recovery wait override replace an explicit readiness budget", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", "1");
    vi.stubEnv("NEMOCLAW_SANDBOX_READY_TIMEOUT", "6");
    const commandExecutor = sequencedExecutor(completed(1, OPENSHELL_SANDBOX_NOT_READY_STDERR));
    const sleeps: number[] = [];

    expect(
      await waitForRecreatedSandboxOpenShellReady("recreated-box", {
        commandExecutor,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: Number(process.env.NEMOCLAW_SANDBOX_READY_TIMEOUT),
      }),
    ).toBe(false);
    expect(commandExecutor.runBuffered).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([]);
  });
});

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

  it("accepts the same managed controller proof for a Podman sandbox", () => {
    requestGatewaySupervisorAction.mockClear();
    expect(
      confirmRecoveredSandboxGatewayManaged("my-sandbox", {
        getSandboxImpl: () => ({ ...openClawEntry, openshellDriver: "podman" }),
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

  it("keeps unavailable results terminal while exact transient results stay inconclusive", () => {
    const confirm = (stderr: string) =>
      confirmRecoveredSandboxGatewayManaged("my-sandbox", {
        getSandboxImpl: () => openClawEntry,
        getSessionAgentImpl: () => null,
        requestGatewaySupervisorActionImpl: () => ({ status: 1, stdout: "", stderr }),
      });

    expect(confirm("SUPERVISOR_UNAVAILABLE")).toBe(false);
    expect(confirm("SUPERVISOR_BUSY")).toBeNull();
    expect(confirm("SUPERVISOR_DISCOVERY_PENDING")).toBeNull();
    expect(confirm("SUPERVISOR_DISCOVERY_PENDING\nunexpected diagnostic")).toBe(false);
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
    return async () => (remaining.length > 1 ? remaining.shift() : remaining[0]) ?? null;
  };

  it("confirms the gateway is still serving after the settle window", async () => {
    const sleeps: number[] = [];
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([true, true]),
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(true);
    // Default settle window of 25s between the two probes.
    expect(sleeps).toEqual([25]);
  });

  it("uses authenticated managed probes inside and at the settle deadline", async () => {
    const sleeps: number[] = [];
    const managedProbe = vi.fn(async () => true);
    const ordinaryProbe = vi.fn(async () => false);
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      probeImpl: ordinaryProbe,
      managedProbeImpl: managedProbe,
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(true);
    expect(managedProbe).toHaveBeenCalledTimes(2);
    expect(ordinaryProbe).not.toHaveBeenCalled();
    expect(sleeps).toEqual([22, 3]);
  });

  it("retries one transient managed result without extending the settle window", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "5";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "2";
    const sleeps: number[] = [];
    const managedProbe = vi.fn(makeProbe([null, true]));
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      managedProbeImpl: managedProbe,
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(true);
    expect(managedProbe).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3, 2]);
  });

  it("keeps a recent authenticated result when only the deadline probe is transient", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "5";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "2";
    const sleeps: number[] = [];
    const managedProbe = vi.fn(makeProbe([true, null]));
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      managedProbeImpl: managedProbe,
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(true);
    expect(managedProbe).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3, 2]);
  });

  it("does not let ordinary outer-namespace health override a managed probe failure", async () => {
    const sleeps: number[] = [];
    const managedProbe = vi.fn(async () => false);
    const ordinaryProbe = vi.fn(async () => true);
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      probeImpl: ordinaryProbe,
      managedProbeImpl: managedProbe,
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(false);
    expect(managedProbe).toHaveBeenCalledOnce();
    expect(ordinaryProbe).not.toHaveBeenCalled();
    expect(sleeps).toEqual([22]);
  });

  it("accepts the initial managed proof without another probe when settling is disabled", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";
    const managedProbe = vi.fn(async () => false);
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      probeImpl: async () => false,
      managedProbeImpl: managedProbe,
      sleepImpl: () => {},
    });
    expect(ok).toBe(true);
    expect(managedProbe).not.toHaveBeenCalled();
  });

  it("uses the bounded recovery window for transient stopped probes", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "6";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    const sleeps: number[] = [];
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([true, false, false, true]),
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([25, 3, 3]);
  });

  it("uses the bounded recovery window for inconclusive post-settle transport", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "6";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    const sleeps: number[] = [];
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([true, null, null, true]),
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([25, 3, 3]);
  });

  it("fails closed when post-settle transport stays inconclusive for the bounded window", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "6";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    const sleeps: number[] = [];
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([true, null]),
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(false);
    expect(sleeps).toEqual([25, 3, 3]);
  });

  it("fails recovery when the gateway serves once and then drops its listener (wedge)", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "6";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    const sleeps: number[] = [];
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      probeImpl: makeProbe([true]),
      managedProbeImpl: async () => false,
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(false);
    expect(sleeps).toEqual([22]);
  });

  it("skips the settle confirm when NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS=0", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";
    const sleeps: number[] = [];
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      // A second probe would report the wedge; with the settle disabled the
      // first success must win and no second probe may run.
      probeImpl: makeProbe([true, false]),
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it("still polls through initial failures before reaching the settle confirm", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "5";
    const sleeps: number[] = [];
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([false, false, true, true]),
      sleepImpl: async (seconds: number) => {
        sleeps.push(seconds);
      },
    });
    expect(ok).toBe(true);
    // Two poll intervals (default 3s) before the first success, then the
    // settle window.
    expect(sleeps).toEqual([3, 3, 5]);
  });

  it("returns false when the gateway never serves within the wait budget", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "0";
    const ok = await waitForRecoveredSandboxGateway("my-sandbox", {
      probeImpl: makeProbe([false]),
      sleepImpl: () => {},
    });
    expect(ok).toBe(false);
  });

  it("uses the manifest health timeout threaded by the recovery caller", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";
    let probes = 0;

    const ok = await waitForRecoveredSandboxGateway("hermes-box", {
      probeImpl: async () => {
        probes += 1;
        return false;
      },
      sleepImpl: () => {},
      timeoutSeconds: 90,
    });

    expect(ok).toBe(false);
    expect(probes).toBe(31);
  });

  it("lets the recovery wait environment override take precedence over the manifest timeout", async () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "6";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "3";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";
    let probes = 0;

    const ok = await waitForRecoveredSandboxGateway("hermes-box", {
      probeImpl: async () => {
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
