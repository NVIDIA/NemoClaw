// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../../test/support/connect-flow-test-harness";
import {
  configureMissingHermesForwardCapture,
  createHermesPortableForwardRecoveryFixture as createRecoveryFixture,
} from "../../../../../test/support/hermes-portable-forward-recovery-fixture";
import {
  HermesPortableForwardRecoveryError,
  prepareHermesPortableLaunchForwards,
  recoverHermesPortableLaunchForwards,
  verifyHermesPortableLaunchForwards,
} from "./hermes-portable-forward-recovery";

type RunForwardMutation = ReturnType<
  typeof createRecoveryFixture
>["input"]["deps"]["runCurrentMutation"];

function runThen(
  run: RunForwardMutation,
  command: string,
  afterRun: () => void,
): RunForwardMutation {
  const afterRunByCommand = new Map([[command, afterRun]]);
  return (args, timeout) => {
    const result = run(args, timeout);
    afterRunByCommand.get(args[1] ?? "")?.();
    return result;
  };
}

describe("Hermes Portable probe-only forward recovery", () => {
  it("restores each missing required forward once through the owning gateway", () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642] });

    expect(recoverHermesPortableLaunchForwards(fixture.input)).toEqual({
      kind: "restored",
      restoredPorts: [18_789, 8_642],
    });

    const starts = fixture.currentCalls.filter((args) => args[1] === "start");
    expect(starts).toEqual([
      ["forward", "start", "--background", "18789", "alpha", "--gateway", "nemoclaw"],
      ["forward", "start", "--background", "8642", "alpha", "--gateway", "nemoclaw"],
    ]);
    expect(fixture.currentCalls.filter((args) => args[1] === "stop")).toEqual([]);
    expect(fixture.currentCalls.filter((args) => args[1] === "list")).toHaveLength(3);
    expect(fixture.currentCaptureCalls.every((args) => args[1] === "list")).toBe(true);
    expect(fixture.currentMutationCalls).toEqual(starts);
    expect(fixture.rollbackCalls).toEqual([]);
    expect([...fixture.records.keys()]).toEqual([18_789, 8_642]);
  });

  it("keeps an already healthy forward set verification-only", () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642], running: [18_789, 8_642] });

    expect(recoverHermesPortableLaunchForwards(fixture.input)).toEqual({
      kind: "verified",
      restoredPorts: [],
    });
    expect(fixture.currentCalls).toEqual([["forward", "list", "--gateway", "nemoclaw"]]);
    expect(fixture.rollbackCalls).toEqual([]);
  });

  it("reports a missing forward without starting or stopping it", () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642], running: [18_789] });

    expect(verifyHermesPortableLaunchForwards(fixture.input)).toEqual({ kind: "unhealthy" });
    expect(fixture.currentCalls).toEqual([["forward", "list", "--gateway", "nemoclaw"]]);
    expect(fixture.rollbackCalls).toEqual([]);
  });

  it("verifies exact forward ownership and reachability without mutation", () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642], running: [18_789, 8_642] });

    expect(verifyHermesPortableLaunchForwards(fixture.input)).toEqual({ kind: "healthy" });
    expect(fixture.currentCalls).toEqual([["forward", "list", "--gateway", "nemoclaw"]]);
    expect(fixture.rollbackCalls).toEqual([]);
  });

  it("keeps exact active forwards verification-only", () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642], active: [18_789, 8_642] });

    expect(recoverHermesPortableLaunchForwards(fixture.input)).toEqual({
      kind: "verified",
      restoredPorts: [],
    });
    expect(fixture.currentCalls).toEqual([["forward", "list", "--gateway", "nemoclaw"]]);
    expect(fixture.rollbackCalls).toEqual([]);
  });

  it.each([
    ["stopped", { stopped: [18_789] }],
    ["dead after the host session ends", { dead: [18_789] }],
  ])("restores an exact %s forward", (_state, options) => {
    const fixture = createRecoveryFixture(options);

    expect(recoverHermesPortableLaunchForwards(fixture.input)).toEqual({
      kind: "restored",
      restoredPorts: [18_789],
    });
    expect(fixture.currentCalls.filter((args) => args[1] === "stop")).toHaveLength(1);
    expect(fixture.currentCalls.filter((args) => args[1] === "start")).toHaveLength(1);
    expect(fixture.currentCalls.filter((args) => args[1] === "list")).toHaveLength(2);
    expect(fixture.rollbackCalls).toEqual([]);
  });

  it.each(["dead", "stopped"])(
    "restarts a target-owned %s row even when the port remains reachable",
    (status) => {
      const fixture = createRecoveryFixture(
        status === "dead" ? { dead: [18_789] } : { stopped: [18_789] },
      );
      fixture.records.get(18_789)!.reachable = true;

      expect(recoverHermesPortableLaunchForwards(fixture.input).kind).toBe("restored");
      expect(
        fixture.currentCalls
          .filter((args) => ["start", "stop"].includes(args[1]!))
          .map((args) => args[1]),
      ).toEqual(["stop", "start"]);
    },
  );

  it("restarts a target-owned live forward that is unreachable", () => {
    const fixture = createRecoveryFixture({ running: [18_789] });
    fixture.records.get(18_789)!.reachable = false;

    expect(recoverHermesPortableLaunchForwards(fixture.input)).toEqual({
      kind: "restored",
      restoredPorts: [18_789],
    });
    expect(
      fixture.currentCalls
        .filter((args) => ["start", "stop"].includes(args[1]!))
        .map((args) => args[1]),
    ).toEqual(["stop", "start"]);
  });

  it.each(["dead", "stopped"])("rejects a foreign %s row before mutation", (status) => {
    const fixture = createRecoveryFixture({
      listOutput: `SANDBOX BIND PORT PID STATUS\nbeta 127.0.0.1 18789 12345 ${status}`,
    });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "forward-occupied" }),
    );
    expect(fixture.currentCalls.some((args) => ["start", "stop"].includes(args[1]!))).toBe(false);
  });

  it("rejects a reachable port with no listed owner before mutation", () => {
    const fixture = createRecoveryFixture();
    Object.assign(fixture.input.deps, { isPortReachable: () => true });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "forward-occupied" }),
    );
    expect(fixture.currentCalls.some((args) => ["start", "stop"].includes(args[1]!))).toBe(false);
  });

  it("records command counts and overlapping settlement timing for an absent forward", () => {
    const fixture = createRecoveryFixture();
    const capture = fixture.input.deps.captureCurrentList;
    const runMutation = fixture.input.deps.runCurrentMutation;
    let now = 0;
    Object.assign(fixture.input.deps, {
      captureCurrentList: (args: readonly string[], timeout: number) => {
        const result = capture(args, timeout);
        now += 2;
        return result;
      },
      runCurrentMutation: (args: readonly string[], timeout: number) => {
        const result = runMutation(args, timeout);
        now += args[1] === "stop" ? 3 : 5;
        return result;
      },
      now: () => now,
      sleep: (milliseconds: number) => {
        now += milliseconds;
      },
    });
    const onComplete = vi.fn();
    Object.assign(fixture.input, { timing: { now: () => now, onComplete } });

    expect(recoverHermesPortableLaunchForwards(fixture.input).kind).toBe("restored");
    expect(onComplete).toHaveBeenCalledWith({
      listMs: 4,
      listCount: 2,
      stopMs: 0,
      stopCount: 0,
      startMs: 5,
      startCount: 1,
      settleMs: 2,
      settleCount: 1,
      totalMs: 9,
      result: "proved",
    });
  });

  it("keeps timing output outside forward recovery behavior", () => {
    const fixture = createRecoveryFixture();
    Object.assign(fixture.input, {
      timing: {
        onComplete: () => {
          throw new Error("timing sink canary");
        },
      },
    });

    expect(recoverHermesPortableLaunchForwards(fixture.input).kind).toBe("restored");
  });

  it("accepts a returned nonzero start only after the exact owner settles healthy", () => {
    const fixture = createRecoveryFixture({ startStatus: 1 });

    expect(recoverHermesPortableLaunchForwards(fixture.input).kind).toBe("restored");
    expect(fixture.currentCalls.filter((args) => args[1] === "start")).toHaveLength(1);
  });

  it("rolls back a possibly started forward when detached mutation transport throws", () => {
    const fixture = createRecoveryFixture();
    const runMutation = fixture.input.deps.runCurrentMutation;
    const captureRollbackList = fixture.input.deps.captureRollbackList;
    const rollbackSequence: string[] = [];
    const onComplete = vi.fn(
      (evidence: { readonly result: "proved" | "failed" }) =>
        rollbackSequence.push(`timing:${evidence.result}`),
    );
    Object.assign(fixture.input.deps, {
      runCurrentMutation: runThen(runMutation, "start", () => {
        throw new Error("detached mutation transport canary");
      }),
      captureRollbackList: (args: readonly string[], timeout: number) => {
        const result = captureRollbackList(args, timeout);
        rollbackSequence.push("rollback-list");
        return result;
      },
    });
    Object.assign(fixture.input, { timing: { onComplete } });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "recovery-failed" }),
    );
    expect(fixture.rollbackMutationCalls).toContainEqual([
      "forward",
      "stop",
      "18789",
      "alpha",
      "--gateway",
      "nemoclaw",
    ]);
    expect(fixture.records.has(18_789)).toBe(false);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ result: "failed", startCount: 1 }),
    );
    expect(rollbackSequence.at(-1)).toBe("timing:failed");
  });

  it("rejects a returned nonzero start without the exact settled owner", () => {
    const fixture = createRecoveryFixture({ startStatus: 1, startUpdatesState: false });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "recovery-failed" }),
    );
    expect(fixture.records.has(18_789)).toBe(false);
    expect(fixture.elapsedMs()).toBe(3_000);
    expect(fixture.currentCalls.filter((args) => args[1] === "start")).toHaveLength(1);
    expect(fixture.rollbackCalls.some((args) => args[1] === "stop")).toBe(true);
  });

  it.each([
    ["foreign occupied", { occupied: [18_789] }, "forward-occupied"],
    ["unavailable", { listStatus: 1 }, "forward-state-unavailable"],
    ["malformed", { malformedList: true }, "forward-state-unavailable"],
  ] as const)("rejects %s forward state before mutation", (_label, options, failure) => {
    const fixture = createRecoveryFixture(options);

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure }),
    );
    expect(fixture.currentCalls.some((args) => ["start", "stop"].includes(args[1]!))).toBe(false);
    expect(fixture.rollbackCalls).toEqual([]);
  });

  it.each([
    ["active PID", "alpha 127.0.0.1 18789 not-a-pid active"],
    ["dead PID", "alpha 127.0.0.1 18789 not-a-pid dead"],
    ["bind", "alpha not-an-address 18789 12345 running"],
    ["port", "alpha 127.0.0.1 70000 12345 running"],
    ["status", "alpha 127.0.0.1 18789 12345 uncertain"],
    ["extra column", "alpha 127.0.0.1 18789 12345 running extra"],
  ])("rejects a malformed relevant-row %s before mutation", (_field, row) => {
    const fixture = createRecoveryFixture({
      listOutput: `SANDBOX BIND PORT PID STATUS\n${row}`,
    });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "forward-state-unavailable" }),
    );
    expect(fixture.currentCalls.some((args) => ["start", "stop"].includes(args[1]!))).toBe(false);
    expect(fixture.rollbackCalls).toEqual([]);
  });

  it("fails closed when current authority drifts before recovery", () => {
    const fixture = createRecoveryFixture();
    fixture.setCurrentAllowed(false);

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "authority-drift" }),
    );
    expect(fixture.currentCalls).toEqual([]);
  });

  it("rejects ambiguous duplicate rows before mutation", () => {
    const fixture = createRecoveryFixture({ active: [18_789] });
    Object.assign(fixture.input.deps, {
      captureCurrentList: () => ({
        status: 0,
        output:
          "SANDBOX BIND PORT PID STATUS\n" +
          "alpha 127.0.0.1 18789 12345 active\n" +
          "alpha 127.0.0.1 18789 12346 active",
      }),
    });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "forward-state-unavailable" }),
    );
    expect(fixture.rollbackCalls).toEqual([]);
  });

  it("rejects a foreign active owner before mutation", () => {
    const fixture = createRecoveryFixture({
      listOutput: "SANDBOX BIND PORT PID STATUS\nbeta 127.0.0.1 18789 12345 active",
    });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "forward-occupied" }),
    );
    expect(fixture.currentCalls.some((args) => ["start", "stop"].includes(args[1]!))).toBe(false);
    expect(fixture.rollbackCalls).toEqual([]);
  });

  it("restores the exact missing state when authority drifts after start", () => {
    const fixture = createRecoveryFixture({ driftCurrentAfterStart: true });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "authority-drift" }),
    );
    expect(fixture.rollbackCalls).toContainEqual([
      "forward",
      "stop",
      "18789",
      "alpha",
      "--gateway",
      "nemoclaw",
    ]);
    expect(fixture.records.has(18_789)).toBe(false);
  });

  it("rolls back a possibly started forward when the final currentness fence fails", () => {
    const baseline = createRecoveryFixture();
    const baselineAssertCurrent = vi.fn();
    Object.assign(baseline.input.deps, { assertCurrent: baselineAssertCurrent });
    expect(recoverHermesPortableLaunchForwards(baseline.input).kind).toBe("restored");

    const fixture = createRecoveryFixture();
    const assertCurrent = vi.fn();
    Array.from({ length: baselineAssertCurrent.mock.calls.length - 1 }).forEach(() =>
      assertCurrent.mockImplementationOnce(() => undefined),
    );
    assertCurrent.mockImplementationOnce(() => {
      throw new Error("final currentness canary");
    });
    Object.assign(fixture.input.deps, { assertCurrent });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "authority-drift" }),
    );
    expect(fixture.rollbackCalls).toContainEqual([
      "forward",
      "stop",
      "18789",
      "alpha",
      "--gateway",
      "nemoclaw",
    ]);
    expect(fixture.records.has(18_789)).toBe(false);
  });

  it("accepts an unreachable target-owned stale row as restored during rollback", () => {
    const fixture = createRecoveryFixture();
    const prepared = prepareHermesPortableLaunchForwards(fixture.input);
    const runRollbackMutation = fixture.input.deps.runRollbackMutation;
    Object.assign(fixture.input.deps, {
      runRollbackMutation: runThen(runRollbackMutation, "stop", () => {
        fixture.records.set(18_789, { owner: "alpha", reachable: false, status: "dead" });
      }),
    });

    expect(() => prepared.rollback()).not.toThrow();
  });

  it("rejects a reachable target-owned stale row as restored during rollback", () => {
    const fixture = createRecoveryFixture();
    const prepared = prepareHermesPortableLaunchForwards(fixture.input);
    const runRollbackMutation = fixture.input.deps.runRollbackMutation;
    Object.assign(fixture.input.deps, {
      runRollbackMutation: runThen(runRollbackMutation, "stop", () => {
        fixture.records.set(18_789, { owner: "alpha", reachable: true, status: "dead" });
      }),
    });

    expect(() => prepared.rollback()).toThrow(
      expect.objectContaining({ failure: "restoration-unproved" }),
    );
  });

  it("rolls back every touched forward in reverse order after a partial recovery", () => {
    const fixture = createRecoveryFixture({
      ports: [18_789, 8_642],
      dropStartedPort: 8_642,
    });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "recovery-failed" }),
    );
    expect(
      fixture.rollbackCalls.filter((args) => args[1] === "stop").map((args) => args[2]),
    ).toEqual(["8642", "18789"]);
    expect(fixture.records.size).toBe(0);
  });

  it("rejects settlement when a previously healthy required port disappears", () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642], running: [18_789] });
    const runMutation = fixture.input.deps.runCurrentMutation;
    Object.assign(fixture.input.deps, {
      runCurrentMutation: runThen(runMutation, "start", () => fixture.records.delete(18_789)),
    });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "recovery-failed" }),
    );
    expect(fixture.rollbackCalls).toContainEqual([
      "forward",
      "stop",
      "8642",
      "alpha",
      "--gateway",
      "nemoclaw",
    ]);
  });

  it("reports restoration uncertainty when rollback command authority drifts", () => {
    const fixture = createRecoveryFixture({ startUpdatesState: false });
    fixture.setRollbackAllowed(false);

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "restoration-unproved" }),
    );
  });

  it("rejects invalid or duplicate recorded ports before any command", () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 18_789] });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      HermesPortableForwardRecoveryError,
    );
    expect(fixture.currentCalls).toEqual([]);
  });
});

describe("Hermes Portable connect composition", () => {
  const originalStdoutIsTty = process.stdout.isTTY;

  const acceptedHermesReadiness = () => {
    const entry = {
      name: "alpha",
      agent: "hermes",
      provider: "ollama-local",
      model: "qwen3-vl:4b",
      policies: [],
      openshellDriver: "docker",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
    } as never;
    return {
      entry,
      readinessDecision: {
        kind: "accepted" as const,
        category: "accepted" as const,
        agent: { name: "hermes" },
        sb: entry,
      },
    };
  };

  const bindAcceptedReadinessToCurrentEntry = (
    harness: ReturnType<typeof createConnectHarness>,
  ): void => {
    harness.inspectLaunchReadinessSpy.mockResolvedValue({
      kind: "accepted",
      category: "accepted",
      agent: { name: "hermes" },
      sb: harness.registryEntries[0]!,
    } as never);
  };

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTty,
    });
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("restores a transition-missing forward before launch-readiness publication (#10423)", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    configureMissingHermesForwardCapture(harness);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ agent: "hermes" }),
      "nemoclaw",
      expect.objectContaining({
        assertCurrent: harness.assertHermesPortableOperatingCommandCurrentSpy,
      }),
      expect.objectContaining({ onComplete: expect.any(Function) }),
    );
    const startCall = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === "forward" && args[1] === "start",
    );
    expect(startCall?.[0]).toEqual([
      "forward",
      "start",
      "--background",
      "18789",
      "alpha",
      "--gateway",
      "nemoclaw",
    ]);
    expect(startCall?.[1]).toEqual(
      expect.objectContaining({
        ignoreError: true,
        openshellBinary: "/usr/bin/openshell",
        replaceEnv: true,
        stdio: "ignore",
        timeout: 30_000,
      }),
    );
    expect(
      harness.captureResolvedOpenshellSpy.mock.calls.every(
        ([args]) =>
          !Array.isArray(args) ||
          args[0] !== "forward" ||
          !["start", "stop"].includes(String(args[1])),
      ),
    ).toBe(true);
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      harness.publishLaunchReadinessSpy.mock.invocationCallOrder[0]!,
    );
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(
      /forwardAction=restored result=ready/,
    );
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(
      /Hermes Portable forward recovery timing: list=\d+ms listCount=2 stop=0ms stopCount=0 start=\d+ms startCount=1 settle=\d+ms settleCount=1 total=\d+ms result=proved/u,
    );
  });

  it("restores an exact dead forward once before launch-readiness publication (#10423)", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    configureMissingHermesForwardCapture(harness, {
      initialStatus: "dead",
      afterStart: () => {
        expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    const mutations = harness.runOpenshellSpy.mock.calls
      .filter(
        ([args]) =>
          Array.isArray(args) &&
          args[0] === "forward" &&
          ["start", "stop"].includes(String(args[1])),
      )
      .map(([args]) => (args as string[])[1]);
    expect(mutations).toEqual(["stop", "start"]);
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(
      /forwardAction=restored result=ready/,
    );
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(
      /Hermes Portable forward recovery timing: list=\d+ms listCount=2 stop=\d+ms stopCount=1 start=\d+ms startCount=1 settle=\d+ms settleCount=1 total=\d+ms result=proved/u,
    );
  });

  it.each([
    ["missing", ["start"]],
    ["dead", ["stop", "start"]],
  ] as const)(
    "restores an accepted-readiness %s forward before reporting probe success",
    async (initialStatus, expectedMutations) => {
      const accepted = acceptedHermesReadiness();
      const harness = createConnectHarness({
        agentName: "hermes",
        sessionAgent: { name: "hermes" },
        registryEntry: accepted.entry,
        portableReceiptDisposition: { kind: "hermes", phase: "active" },
        portableRecoveryResult: { kind: "already-running" },
        readinessDecision: accepted.readinessDecision,
      });
      bindAcceptedReadinessToCurrentEntry(harness);
      configureMissingHermesForwardCapture(harness, {
        initialStatus,
        afterStart: () => {
          expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain(
            "Probe complete: launch readiness is healthy",
          );
        },
      });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

      const mutations = harness.runOpenshellSpy.mock.calls
        .filter(
          ([args]) =>
            Array.isArray(args) &&
            args[0] === "forward" &&
            ["start", "stop"].includes(String(args[1])),
        )
        .map(([args]) => (args as string[])[1]);
      expect(mutations).toEqual(expectedMutations);
      expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
      expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
        "Probe complete: launch readiness is healthy for 'alpha'.",
      );
    },
  );

  it("does not report accepted readiness when forward recovery fails", async () => {
    const accepted = acceptedHermesReadiness();
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      registryEntry: accepted.entry,
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
      readinessDecision: accepted.readinessDecision,
    });
    bindAcceptedReadinessToCurrentEntry(harness);
    const captureResolved = harness.captureResolvedOpenshellSpy.getMockImplementation()!;
    harness.captureResolvedOpenshellSpy.mockImplementation(((args: unknown, options: unknown) => {
      const argv = Array.isArray(args) ? args : [];
      return argv[0] === "forward" && argv[1] === "list"
        ? { status: 0, output: "malformed canary" }
        : captureResolved(args, options);
    }) as never);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain(
      "Probe complete: launch readiness is healthy",
    );
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(
      /Hermes Portable forward recovery timing: .*listCount=1 .*result=failed/u,
    );
    expect(
      harness.runOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && ["start", "stop"].includes(String(args[1])),
      ),
    ).toBe(false);
  });

  it("restores a recovered Ollama runtime when forward settlement fails", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    let ollamaRunning = false;
    harness.recoverHermesPortableOllamaInferenceSpy.mockImplementation(((input: {
      verifyRoute: () => unknown;
      prepareProbeDependency?: () => { release: () => void; rollback: () => void };
    }) => {
      ollamaRunning = true;
      try {
        input.verifyRoute();
        input.prepareProbeDependency?.().release();
        return "recovered";
      } catch (error) {
        ollamaRunning = false;
        throw error;
      }
    }) as never);
    let forwardStarted = false;
    const forward = configureMissingHermesForwardCapture(harness, {
      afterStart: () => {
        forwardStarted = true;
      },
    });
    const captureForward = harness.captureResolvedOpenshellSpy.getMockImplementation()!;
    harness.captureResolvedOpenshellSpy.mockImplementation(((args: unknown, options: unknown) => {
      const argv = Array.isArray(args) ? args : [];
      return forwardStarted && forward.isRunning() && argv[0] === "forward" && argv[1] === "list"
        ? { status: 0, output: "malformed canary" }
        : captureForward(args, options);
    }) as never);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(forward.isRunning()).toBe(false);
    expect(ollamaRunning).toBe(false);
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("restores prepared forwards when Ollama finalization fails", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    let ollamaRunning = false;
    harness.recoverHermesPortableOllamaInferenceSpy.mockImplementation(((input: {
      verifyRoute: () => unknown;
      prepareProbeDependency?: () => { rollback: () => void };
    }) => {
      ollamaRunning = true;
      input.verifyRoute();
      const dependency = input.prepareProbeDependency?.();
      dependency?.rollback();
      ollamaRunning = false;
      throw new Error("finalization canary");
    }) as never);
    const forward = configureMissingHermesForwardCapture(harness);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(forward.isRunning()).toBe(false);
    expect(ollamaRunning).toBe(false);
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).not.toContain("finalization canary");
  });

  it("reports forward restoration uncertainty after restoring Ollama", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    let ollamaRunning = false;
    harness.recoverHermesPortableOllamaInferenceSpy.mockImplementation(((input: {
      verifyRoute: () => unknown;
      prepareProbeDependency?: () => { rollback: () => void };
    }) => {
      ollamaRunning = true;
      input.verifyRoute();
      const dependency = input.prepareProbeDependency?.();
      harness.assertHermesPortableOperatingCommandCurrentSpy.mockImplementation(() => {
        throw new Error("rollback authority canary");
      });
      try {
        dependency?.rollback();
      } catch (error) {
        ollamaRunning = false;
        throw error;
      }
      throw new Error("expected rollback failure");
    }) as never);
    const forward = configureMissingHermesForwardCapture(harness);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(forward.isRunning()).toBe(true);
    expect(ollamaRunning).toBe(false);
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("returned to a stopped state");
    expect(output).not.toContain("rollback authority canary");
  });

  it("stops before publication when the owning gateway forward list is malformed", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    const captureResolved = harness.captureResolvedOpenshellSpy.getMockImplementation()!;
    harness.captureResolvedOpenshellSpy.mockImplementation(((args: unknown, options: unknown) => {
      const argv = Array.isArray(args) ? args : [];
      return argv[0] === "forward" && argv[1] === "list"
        ? { status: 0, output: "malformed canary" }
        : captureResolved(args, options);
    }) as never);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(
      harness.runOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && ["start", "stop"].includes(String(args[1])),
      ),
    ).toBe(false);
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Hermes Portable host-forward recovery");
    expect(output).not.toContain("malformed canary");
  });

  it("rejects a same-path executable generation change before forward mutation", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    harness.assertHermesPortableOperatingCommandCurrentSpy
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error("same-path executable replacement canary");
      });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(
      harness.captureResolvedOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "forward",
      ),
    ).toBe(false);
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("changed during launch-readiness verification");
    expect(output).not.toContain("same-path executable replacement canary");
  });

  it("reports restoration uncertainty when executable identity changes after start", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    const forward = configureMissingHermesForwardCapture(harness, {
      afterStart: () => {
        harness.assertHermesPortableOperatingCommandCurrentSpy.mockImplementation(() => {
          throw new Error("same-path executable replacement canary");
        });
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(forward.isRunning()).toBe(true);
    expect(
      harness.runOpenshellSpy.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === "forward" && args[1] === "stop",
      ),
    ).toHaveLength(0);
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("returned to a stopped state");
    expect(output).not.toContain("same-path executable replacement canary");
  });

  it("restores the missing state when registry authority drifts after start", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    const forward = configureMissingHermesForwardCapture(harness, {
      afterStart: () => {
        harness.registryEntries[0]!.gatewayName = "changed-gateway";
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(
      harness.runOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "forward" && args[1] === "stop",
      ),
    ).toBe(true);
    expect(forward.isRunning()).toBe(false);
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "authority changed during host-forward recovery",
    );
  });

  it("keeps direct interactive connect outside the probe-only forward recovery seam", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(
      harness.runOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "forward",
      ),
    ).toBe(false);
  });
});
