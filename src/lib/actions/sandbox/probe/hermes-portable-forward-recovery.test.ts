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
  recoverHermesPortableLaunchForwards,
} from "./hermes-portable-forward-recovery";

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

  it("accepts a returned nonzero start only after the exact owner settles healthy", () => {
    const fixture = createRecoveryFixture({ startStatus: 1 });

    expect(recoverHermesPortableLaunchForwards(fixture.input).kind).toBe("restored");
    expect(fixture.currentCalls.filter((args) => args[1] === "start")).toHaveLength(1);
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
    ["PID", "alpha 127.0.0.1 18789 not-a-pid running"],
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
    const fixture = createRecoveryFixture({ running: [18_789] });
    Object.assign(fixture.input.deps, {
      captureCurrent: () => ({
        status: 0,
        output:
          "SANDBOX BIND PORT PID STATUS\n" +
          "alpha 127.0.0.1 18789 12345 running\n" +
          "alpha 127.0.0.1 18789 12346 running",
      }),
    });

    expect(() => recoverHermesPortableLaunchForwards(fixture.input)).toThrow(
      expect.objectContaining({ failure: "forward-state-unavailable" }),
    );
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

    const startCall = harness.captureResolvedOpenshellSpy.mock.calls.find(
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
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(harness.captureResolvedOpenshellSpy.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      harness.publishLaunchReadinessSpy.mock.invocationCallOrder[0]!,
    );
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(
      /forwardAction=restored result=ready/,
    );
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
      harness.captureResolvedOpenshellSpy.mock.calls.some(
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
    expect(output).toContain("authority changed during host-forward recovery");
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
      harness.captureResolvedOpenshellSpy.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === "forward" && args[1] === "stop",
      ),
    ).toHaveLength(1);
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
      harness.captureResolvedOpenshellSpy.mock.calls.some(
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
      harness.captureResolvedOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "forward",
      ),
    ).toBe(false);
  });
});
