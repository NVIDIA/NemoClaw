// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("managed gateway control completion", () => {
  const nonce = "a".repeat(64);

  it.each([
    ["ok", 0, 4242],
    ["ok", 4242, 4242],
    ["already-running", 4242, 4242],
    ["already-running", 4242, 5252],
  ] as const)("preserves the exact %s controller disposition (#7919)", (disposition, oldPid, newPid) => {
    expect(
      parseManagedGatewayControlCompletion({
        status: 0,
        stdout: `v1 ${nonce} complete ${disposition} ${oldPid} ${newPid}\nGATEWAY_PID=${newPid}`,
        stderr: "",
      }),
    ).toEqual({ disposition, oldPid, newPid });
  });

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

  it("retries the structured not-ready state until OpenShell accepts the sandbox", () => {
    const notReady = {
      status: 1,
      output: OPENSHELL_SANDBOX_NOT_READY_STDERR.trim(),
      stdout: "",
      stderr: OPENSHELL_SANDBOX_NOT_READY_STDERR,
    };
    const captureOpenshellImpl = vi
      .fn()
      .mockReturnValueOnce(notReady)
      .mockReturnValueOnce(notReady)
      .mockReturnValueOnce({ status: 0, output: "", stdout: "", stderr: "" });
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(true);
    expect(captureOpenshellImpl).toHaveBeenCalledTimes(3);
    expect(captureOpenshellImpl).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "recreated-box", "--", "true"],
      expect.objectContaining({
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
      }),
    );
    expect(beforeProbe).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([3, 3]);
  });

  it("retries the same-sandbox Error phase until OpenShell accepts the sandbox", () => {
    const captureOpenshellImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        output: OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR.trim(),
        stdout: "",
        stderr: OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR,
      })
      .mockReturnValueOnce({ status: 0, output: "", stdout: "", stderr: "" });
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(captureOpenshellImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3]);
  });

  it("retries the exact same-sandbox Error phase when OpenShell also emits informational stdout", () => {
    const captureOpenshellImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        output:
          `Waiting for sandbox registration\n${OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR}`.trim(),
        stdout: "Waiting for sandbox registration\n",
        stderr: OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR,
      })
      .mockReturnValueOnce({ status: 0, output: "", stdout: "", stderr: "" });
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe: () => true,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(true);
    expect(captureOpenshellImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3]);
  });

  it("keeps an empty read-only probe inconclusive after exact replacement re-registration", () => {
    const captureOpenshellImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        output: OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR.trim(),
        stdout: "",
        stderr: OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR,
      })
      .mockReturnValueOnce({ status: 1, output: "", stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, output: "", stdout: "", stderr: "" });
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(3);
    expect(captureOpenshellImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([3, 3]);
  });

  it("keeps an empty first OpenShell failure terminal", () => {
    const captureOpenshellImpl = vi.fn(() => ({
      status: 1,
      output: "",
      stdout: "",
      stderr: "",
    }));
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe: () => true,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(false);
    expect(captureOpenshellImpl).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([]);
  });

  it("rides out a transient Error phase past the old 30s budget by default (#7227)", () => {
    // No timeoutSeconds option and no env override: the default recovery budget
    // must be large enough (120s, aligned with connect's readiness wait) to keep
    // retrying a cold-start phase:Error settling window that exceeds the old
    // 30s / 11-attempt budget. The 12th probe (past the old 11-attempt cap) must
    // still be reached, so the primary dashboard/API forward is not abandoned.
    delete process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS;
    const errorPhase = {
      status: 1,
      output: OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR.trim(),
      stdout: "",
      stderr: OPENSHELL_TRANSIENT_ERROR_PHASE_STDERR,
    };
    const captureOpenshellImpl = vi.fn();
    for (let attempt = 0; attempt < 11; attempt += 1) {
      captureOpenshellImpl.mockReturnValueOnce(errorPhase);
    }
    captureOpenshellImpl.mockReturnValueOnce({
      status: 0,
      output: "",
      stdout: "",
      stderr: "",
    });

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe: () => true,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: () => {},
        // no timeoutSeconds -> exercise the default budget; the old 30s default
        // capped at 11 attempts and would have given up before the 12th probe.
      }),
    ).toBe(true);
    expect(captureOpenshellImpl).toHaveBeenCalledTimes(12);
  });

  it("retries the exact supervisor reconnect states exposed during direct recreation", () => {
    const reconnecting = [
      OPENSHELL_SUPERVISOR_NOT_CONNECTED_STDERR,
      OPENSHELL_SUPERVISOR_DISCONNECTED_STDERR,
    ].map((stderr) => ({
      status: 1,
      output: stderr.trim(),
      stdout: "",
      stderr,
    }));
    const captureOpenshellImpl = vi
      .fn()
      .mockReturnValueOnce(reconnecting[0])
      .mockReturnValueOnce(reconnecting[1])
      .mockReturnValueOnce({ status: 0, output: "", stdout: "", stderr: "" });
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(true);
    expect(captureOpenshellImpl).toHaveBeenCalledTimes(3);
    expect(beforeProbe).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([3, 3]);
  });

  it.each([
    OPENSHELL_RELAY_OPEN_TIMED_OUT_STDERR,
    OPENSHELL_SUPERVISOR_RELAY_CHANNEL_TIMED_OUT_STDERR,
  ])("retries when the connected supervisor misses OpenShell's relay deadline (#7227)", (stderr) => {
    const captureOpenshellImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        output: stderr.trim(),
        stdout: "",
        stderr,
      })
      .mockReturnValueOnce({ status: 0, output: "", stdout: "", stderr: "" });
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(captureOpenshellImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3]);
  });

  it("retries when OpenShell drops the replacement supervisor's reverse relay", () => {
    const captureOpenshellImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        output: OPENSHELL_RELAY_CHANNEL_DROPPED_STDERR.trim(),
        stdout: "",
        stderr: OPENSHELL_RELAY_CHANNEL_DROPPED_STDERR,
      })
      .mockReturnValueOnce({ status: 0, output: "", stdout: "", stderr: "" });
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(captureOpenshellImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3]);
  });

  it.each([
    OPENSHELL_RELAY_TARGET_NOT_FOUND_STDERR,
    OPENSHELL_RELAY_TARGET_REFUSED_STDERR,
  ])("retries while the replacement supervisor's local relay target starts (#7273)", (stderr) => {
    const captureOpenshellImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        output: stderr.trim(),
        stdout: "",
        stderr,
      })
      .mockReturnValueOnce({ status: 0, output: "", stdout: "", stderr: "" });
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(captureOpenshellImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3]);
  });

  it.each([
    `Error:   × status: DeadlineExceeded, message: "policy update timed out"`,
    `Error:   × code: 'The service is currently unavailable', message: "supervisor
  │ relay failed: status: DeadlineExceeded, message: \\"relay requester timed
  │ out\\", details: [], metadata: MetadataMap { headers: {} }"`,
    `Error:   × code: 'The service is currently unavailable', message: "permission denied"`,
    "Error: sandbox 'other-box' is not ready (phase: Error); wait for it to reach Ready state.",
    "Error: sandbox 'recreated-box' is not ready (phase: Failed); wait for it to reach Ready state.",
  ])("does not retry an unrelated OpenShell error", (stderr) => {
    const captureOpenshellImpl = vi.fn(() => ({
      status: 1,
      output: stderr,
      stdout: "",
      stderr,
    }));
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(false);
    expect(captureOpenshellImpl).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([]);
  });

  it("fails immediately on an unknown OpenShell error", () => {
    const captureOpenshellImpl = vi.fn(() => ({
      status: 1,
      output: "permission denied",
      stdout: "",
      stderr: "permission denied",
    }));
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(false);
    expect(captureOpenshellImpl).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([]);
  });

  it("retries the no-op OpenShell readiness probe after a command timeout (#7273)", () => {
    const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const captureOpenshellImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: null,
        output: "",
        stdout: "",
        stderr: "",
        error: timeoutError,
      })
      .mockReturnValueOnce({ status: 0, output: "", stdout: "", stderr: "" });
    const beforeProbe = vi.fn(() => true);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 30,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(captureOpenshellImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3]);
  });

  it("rechecks the pinned managed guard before every readiness retry", () => {
    const captureOpenshellImpl = vi.fn(() => ({
      status: 1,
      output: OPENSHELL_SANDBOX_NOT_READY_STDERR.trim(),
      stdout: "",
      stderr: OPENSHELL_SANDBOX_NOT_READY_STDERR,
    }));
    const beforeProbe = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(false);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(captureOpenshellImpl).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([3]);
  });

  it("retries an inconclusive managed guard within the readiness deadline", () => {
    const captureOpenshellImpl = vi.fn(() => ({
      status: 0,
      output: "",
      stdout: "",
      stderr: "",
    }));
    const beforeProbe = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(true);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(true);
    expect(beforeProbe).toHaveBeenCalledTimes(2);
    expect(captureOpenshellImpl).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([3]);
  });

  it("fails closed on a definitive managed guard failure without probing OpenShell", () => {
    const captureOpenshellImpl = vi.fn(() => ({
      status: 0,
      output: "",
      stdout: "",
      stderr: "",
    }));
    const beforeProbe = vi.fn(() => false);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(false);
    expect(beforeProbe).toHaveBeenCalledOnce();
    expect(captureOpenshellImpl).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it("fails when the managed guard stays inconclusive until the deadline", () => {
    const captureOpenshellImpl = vi.fn(() => ({
      status: 0,
      output: "",
      stdout: "",
      stderr: "",
    }));
    const beforeProbe = vi.fn(() => null);
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        beforeProbe,
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: 6,
      }),
    ).toBe(false);
    expect(beforeProbe).toHaveBeenCalledTimes(3);
    expect(captureOpenshellImpl).not.toHaveBeenCalled();
    expect(sleeps).toEqual([3, 3]);
  });

  it("lets the recovery wait override replace an explicit readiness budget", () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", "1");
    vi.stubEnv("NEMOCLAW_SANDBOX_READY_TIMEOUT", "6");
    const captureOpenshellImpl = vi.fn(() => ({
      status: 1,
      output: OPENSHELL_SANDBOX_NOT_READY_STDERR.trim(),
      stdout: "",
      stderr: OPENSHELL_SANDBOX_NOT_READY_STDERR,
    }));
    const sleeps: number[] = [];

    expect(
      waitForRecreatedSandboxOpenShellReady("recreated-box", {
        captureOpenshellImpl,
        intervalSeconds: 3,
        sleepImpl: (seconds) => sleeps.push(seconds),
        timeoutSeconds: Number(process.env.NEMOCLAW_SANDBOX_READY_TIMEOUT),
      }),
    ).toBe(false);
    expect(captureOpenshellImpl).toHaveBeenCalledOnce();
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

  it("uses authenticated managed probes inside and at the settle deadline", () => {
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
    expect(managedProbe).toHaveBeenCalledTimes(2);
    expect(ordinaryProbe).not.toHaveBeenCalled();
    expect(sleeps).toEqual([22, 3]);
  });

  it("retries one transient managed result without extending the settle window", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "5";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "2";
    const sleeps: number[] = [];
    const managedProbe = vi.fn(makeProbe([null, true]));
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      managedProbeImpl: managedProbe,
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(true);
    expect(managedProbe).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3, 2]);
  });

  it("keeps a recent authenticated result when only the deadline probe is transient", () => {
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "5";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "2";
    const sleeps: number[] = [];
    const managedProbe = vi.fn(makeProbe([true, null]));
    const ok = waitForRecoveredSandboxGateway("my-sandbox", {
      initialManagedHealthPassed: true,
      managedProbeImpl: managedProbe,
      sleepImpl: (seconds: number) => sleeps.push(seconds),
    });
    expect(ok).toBe(true);
    expect(managedProbe).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3, 2]);
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
    expect(sleeps).toEqual([22]);
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
    expect(sleeps).toEqual([22]);
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
