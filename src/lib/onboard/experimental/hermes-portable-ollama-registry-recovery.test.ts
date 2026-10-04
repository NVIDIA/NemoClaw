// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  PortableRegistryRecoveryPhaseError,
  PortableRegistryRecoveryRestorationError,
  preparePortableRegistryRecovery,
} from "./hermes-portable-ollama-authority";

const NETWORK_ID = "6".repeat(64);
const REGISTRY_ID = "7".repeat(64);
const FOREIGN_REGISTRY_ID = "8".repeat(64);
// SHA-256 of the documented canonical network/registry receipt fixture below,
// computed independently from the production authority capture.
const EXPECTED_AUTHORITY_SHA256 =
  "5eca228b8c8674bcacf631f28e5f888b928260876da111e04cfee36ad48b7cff";

function createRegistryHarness(initiallyRunning: boolean) {
  const calls: string[][] = [];
  const timeouts: Array<number | undefined> = [];
  let running = initiallyRunning;
  let status = initiallyRunning ? "running" : "exited";
  let registryId = REGISTRY_ID;
  let registryName = "nemoclaw-portable-registry";
  let registryLabel = "1";
  let registryNetworkId = NETWORK_ID;
  let registryIp = initiallyRunning ? "10.87.0.3" : "";
  let registryCopies = 1;
  let registryPresent = true;
  let networkInterface = "podman9";
  let registryOutput: string | undefined;
  const queuedRegistryOutputs: Array<string | undefined> = [];
  let postStartNetworkFailures = 0;
  let startStatus = 0;
  let startError: Error | undefined;
  let beforeStart: () => void = () => undefined;
  let afterStart: () => void = () => undefined;
  let afterStartInspect: () => void = () => undefined;
  let startLabel: string | undefined;
  let startIp = "10.87.0.3";
  let startChangesState = true;
  let startInvoked = false;
  let stopStatus = 0;
  const engine = {
    capture: vi.fn((args: readonly string[], timeout?: number) => {
      calls.push([...args]);
      timeouts.push(timeout);
      switch (args[0]) {
        case "network":
          expect(args[1]).toBe("inspect");
          const networkFailure = startInvoked && postStartNetworkFailures > 0;
          postStartNetworkFailures -= Number(networkFailure);
          return networkFailure
            ? { status: 1, stdout: "", stderr: "network canary" }
            : {
                status: 0,
                stdout: JSON.stringify([
                  {
                    id: NETWORK_ID,
                    name: "openshell-docker",
                    driver: "bridge",
                    internal: false,
                    ipv6_enabled: false,
                    dns_enabled: true,
                    network_interface: networkInterface,
                    subnets: [{ subnet: "10.87.0.0/24", gateway: "10.87.0.1" }],
                    labels: {},
                    ipam_options: {},
                    options: {},
                  },
                ]),
                stderr: "",
              };
        case "container": {
          expect(args[1]).toBe("inspect");
          startInvoked ? afterStartInspect() : undefined;
          const referenceMatches =
            args[2] === "nemoclaw-portable-registry" || args[2] === registryId;
          const row = {
            Id: registryId,
            Name: registryName,
            Config: { Labels: { "com.nvidia.nemoclaw.portable": registryLabel } },
            State: { Running: running, Status: status },
            NetworkSettings: {
              Networks: {
                "openshell-docker": {
                  NetworkID: registryNetworkId,
                  IPAddress: registryIp,
                },
              },
            },
          };
          return registryPresent && referenceMatches
            ? {
                status: 0,
                stdout:
                  (queuedRegistryOutputs.length > 0
                    ? queuedRegistryOutputs.shift()
                    : registryOutput) ??
                  JSON.stringify(Array.from({ length: registryCopies }, () => row)),
                stderr: "",
              }
            : { status: 1, stdout: "", stderr: "not found" };
        }
        case "start":
          expect(args[1]).toBe(REGISTRY_ID);
          beforeStart();
          startInvoked = true;
          running = startChangesState ? true : running;
          status = startChangesState ? "running" : status;
          registryIp = startChangesState ? startIp : registryIp;
          registryLabel = startLabel ?? registryLabel;
          afterStart();
          return {
            status: startStatus,
            stdout: REGISTRY_ID,
            stderr: "",
            ...(startError ? { error: startError } : {}),
          };
        case "stop":
          expect(args.at(-1)).toBe(REGISTRY_ID);
          running = stopStatus === 0 ? false : running;
          status = stopStatus === 0 ? "exited" : status;
          registryIp = stopStatus === 0 ? "" : registryIp;
          return { status: stopStatus, stdout: REGISTRY_ID, stderr: "" };
        default:
          throw new Error(`Unexpected registry test command: ${args.join(" ")}`);
      }
    }),
  };
  return {
    calls,
    timeouts,
    engine,
    expectedAuthoritySha256: EXPECTED_AUTHORITY_SHA256,
    isRunning: () => running,
    setCopies: (value: number) => {
      registryCopies = value;
    },
    setIdentity: (value: string) => {
      registryId = value;
    },
    setLabel: (value: string) => {
      registryLabel = value;
    },
    setName: (value: string) => {
      registryName = value;
    },
    setNetworkId: (value: string) => {
      registryNetworkId = value;
    },
    setNetworkInterface: (value: string) => {
      networkInterface = value;
    },
    setIp: (value: string) => {
      registryIp = value;
    },
    setPresent: (value: boolean) => {
      registryPresent = value;
    },
    setOutput: (value: string) => {
      registryOutput = value;
    },
    setNextOutput: (value: string | undefined) => {
      queuedRegistryOutputs.push(value);
    },
    setPostStartNetworkFailures: (value: number) => {
      postStartNetworkFailures = value;
    },
    setStartOutcome: (value: { readonly status: number; readonly changesState: boolean }) => {
      startStatus = value.status;
      startChangesState = value.changesState;
    },
    setStartError: (code: string, changesState: boolean) => {
      startStatus = 1;
      startError = Object.assign(new Error("spawnSync podman failed"), { code });
      startChangesState = changesState;
    },
    setStartLabel: (value: string) => {
      startLabel = value;
    },
    setStartIp: (value: string) => {
      startIp = value;
    },
    setBeforeStart: (callback: () => void) => {
      beforeStart = callback;
    },
    setAfterStart: (callback: () => void) => {
      afterStart = callback;
    },
    setAfterStartInspect: (callback: () => void) => {
      afterStartInspect = callback;
    },
    setStartThrows: () => {
      beforeStart = () => {
        throw new Error("registry capture failed");
      };
    },
    setStopStatus: (value: number) => {
      stopStatus = value;
    },
    setStartTimeout: (changesState: boolean) => {
      startStatus = 1;
      startError = Object.assign(new Error("spawnSync podman ETIMEDOUT"), {
        code: "ETIMEDOUT",
      });
      startChangesState = changesState;
    },
  };
}

type RegistryHarness = ReturnType<typeof createRegistryHarness>;

function createFakeTiming(initial = 0) {
  let current = initial;
  const sleeps: number[] = [];
  return {
    timing: {
      now: vi.fn(() => current),
      sleep: vi.fn((milliseconds: number) => {
        sleeps.push(milliseconds);
        current += milliseconds;
      }),
    },
    sleeps,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    current: () => current,
  };
}

function captureRegistryPhase(operation: () => unknown): PortableRegistryRecoveryPhaseError {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PortableRegistryRecoveryPhaseError);
  return caught as PortableRegistryRecoveryPhaseError;
}

const rejectionCases: ReadonlyArray<{
  readonly label: string;
  readonly mutate: (harness: RegistryHarness) => void;
  readonly digestOverride?: string;
}> = [
  { label: "wrong digest", mutate: () => undefined, digestOverride: "9".repeat(64) },
  { label: "ambiguous name", mutate: (harness) => harness.setCopies(2) },
  { label: "foreign name", mutate: (harness) => harness.setName("other") },
  { label: "foreign label", mutate: (harness) => harness.setLabel("0") },
  { label: "foreign network", mutate: (harness) => harness.setNetworkId("8".repeat(64)) },
  { label: "missing registry", mutate: (harness) => harness.setPresent(false) },
];

describe("Hermes Portable registry recovery", () => {
  it("starts and rolls back only the pinned full stopped registry ID", () => {
    const harness = createRegistryHarness(false);
    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );

    expect(prepared.started).toBe(true);
    expect(harness.isRunning()).toBe(true);
    expect(harness.calls).toContainEqual(["start", REGISTRY_ID]);
    prepared.assertCurrent();
    prepared.rollback();
    expect(harness.isRunning()).toBe(false);
    expect(harness.calls).toContainEqual(["stop", "--time", "10", REGISTRY_ID]);
  });

  it("leaves an already running exact registry verification-only", () => {
    const harness = createRegistryHarness(true);
    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );

    expect(prepared.started).toBe(false);
    prepared.assertCurrent();
    prepared.release();
    expect(harness.calls.some((args) => args[0] === "start" || args[0] === "stop")).toBe(false);
  });

  it("uses retained transaction fences without another network or registry inspection", () => {
    const harness = createRegistryHarness(true);
    const assertEngineCurrent = vi.fn();
    const assertCallerCurrent = vi.fn();
    const transactionEngineCurrent = vi.fn();
    const transactionCallerCurrent = vi.fn();
    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      assertEngineCurrent,
      assertCallerCurrent,
      {},
      {
        assertEngineCurrent: transactionEngineCurrent,
        assertCallerCurrent: transactionCallerCurrent,
      },
    );
    const before = harness.calls.length;

    prepared.assertRetainedCurrent();

    expect(transactionCallerCurrent).toHaveBeenCalledOnce();
    expect(transactionEngineCurrent).toHaveBeenCalledOnce();
    expect(assertCallerCurrent).toHaveBeenCalledOnce();
    expect(assertEngineCurrent).toHaveBeenCalledOnce();
    expect(harness.calls).toHaveLength(before);
  });

  it("rejects canonical authority drift against the independently fixed receipt digest", () => {
    const harness = createRegistryHarness(true);
    expect(harness.expectedAuthoritySha256).toBe(EXPECTED_AUTHORITY_SHA256);
    harness.setNetworkInterface("podman10");

    const error = captureRegistryPhase(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    );
    expect(error.phase).toBe("POSTCONDITION");
    expect(harness.calls.some((args) => args[0] === "start" || args[0] === "stop")).toBe(false);
  });

  it.each(rejectionCases)(
    "rejects $label before registry mutation",
    ({ mutate, digestOverride }) => {
      const harness = createRegistryHarness(false);
      mutate(harness);

      expect(() =>
        preparePortableRegistryRecovery(
          harness.engine as never,
          digestOverride ?? harness.expectedAuthoritySha256,
          vi.fn(),
          vi.fn(),
        ),
      ).toThrow();
      expect(harness.calls.some((args) => args[0] === "start" || args[0] === "stop")).toBe(false);
    },
  );

  it("rejects a same-name replacement before starting it", () => {
    const harness = createRegistryHarness(false);
    harness.setIdentity(FOREIGN_REGISTRY_ID);

    expect(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    ).toThrow(PortableRegistryRecoveryPhaseError);
    expect(harness.calls.some((args) => args[0] === "start")).toBe(false);
  });

  it("accepts a nonzero start result after proving the exact registry running", () => {
    const harness = createRegistryHarness(false);
    harness.setStartOutcome({ status: 125, changesState: true });

    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );

    expect(prepared.started).toBe(true);
    expect(harness.isRunning()).toBe(true);
    expect(harness.calls.some((args) => args[0] === "stop")).toBe(false);
  });

  it("accepts an exact running registry after the pinned start times out", () => {
    const harness = createRegistryHarness(false);
    harness.setStartTimeout(true);

    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );

    expect(prepared.started).toBe(true);
    expect(harness.isRunning()).toBe(true);
    expect(harness.calls).toContainEqual(["start", REGISTRY_ID]);
    expect(harness.calls.some((args) => args[0] === "stop")).toBe(false);
  });

  it("uses a fresh bounded settlement window after the start command returns", () => {
    const harness = createRegistryHarness(false);
    const clock = createFakeTiming();
    const ips = ["", "10.87.0.3"];
    harness.setStartTimeout(true);
    harness.setStartIp("");
    harness.setBeforeStart(() => clock.advance(30_000));
    harness.setAfterStartInspect(() => {
      harness.setIp(ips.shift() ?? "10.87.0.3");
    });

    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
      clock.timing,
    );

    expect(prepared.started).toBe(true);
    expect(clock.sleeps).toEqual([1_000]);
    expect(clock.current()).toBe(31_000);
    expect(harness.calls.filter((args) => args[0] === "start")).toEqual([["start", REGISTRY_ID]]);
    const startIndex = harness.calls.findIndex((args) => args[0] === "start");
    expect(
      harness.calls
        .slice(startIndex + 1)
        .filter((args) => args[0] === "container")
        .every((args) => args[2] === REGISTRY_ID),
    ).toBe(true);
    expect(harness.timeouts[startIndex]).toBe(30_000);
  });

  it.each([
    {
      label: "nonzero result",
      configure: (harness: RegistryHarness) =>
        harness.setStartOutcome({ status: 125, changesState: true }),
    },
    {
      label: "ordinary command error",
      configure: (harness: RegistryHarness) => harness.setStartError("EIO", true),
    },
  ])("settles delayed exact running authority after a $label", ({ configure }) => {
    const harness = createRegistryHarness(false);
    const clock = createFakeTiming();
    const ips = ["", "10.87.0.3"];
    configure(harness);
    harness.setStartIp("");
    harness.setAfterStartInspect(() => {
      harness.setIp(ips.shift() ?? "10.87.0.3");
    });

    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
      clock.timing,
    );

    expect(prepared.started).toBe(true);
    expect(clock.sleeps).toEqual([1_000]);
    expect(harness.calls.filter((args) => args[0] === "start")).toHaveLength(1);
    expect(harness.calls.some((args) => args[0] === "stop")).toBe(false);
  });

  it("performs a final exact observation after the settlement deadline", () => {
    const harness = createRegistryHarness(false);
    const clock = createFakeTiming();
    harness.setStartIp("");

    const error = captureRegistryPhase(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
        clock.timing,
      ),
    );
    expect(error.phase).toBe("PENDING_DEADLINE");
    expect(clock.current()).toBe(30_000);
    expect(clock.sleeps).toHaveLength(30);
    expect(clock.sleeps.every((milliseconds) => milliseconds === 1_000)).toBe(true);
    expect(harness.calls.filter((args) => args[0] === "start")).toHaveLength(1);
    expect(harness.calls.filter((args) => args[0] === "stop")).toEqual([
      ["stop", "--time", "10", REGISTRY_ID],
    ]);
    expect(harness.isRunning()).toBe(false);
  });

  it.each([
    { label: "name drift", mutate: (harness: RegistryHarness) => harness.setName("other") },
    { label: "label drift", mutate: (harness: RegistryHarness) => harness.setLabel("0") },
    {
      label: "network drift",
      mutate: (harness: RegistryHarness) => harness.setNetworkId("8".repeat(64)),
    },
    { label: "foreign IP", mutate: (harness: RegistryHarness) => harness.setIp("10.87.0.99") },
    {
      label: "full-ID replacement",
      mutate: (harness: RegistryHarness) => harness.setIdentity(FOREIGN_REGISTRY_ID),
    },
    {
      label: "missing inspection",
      mutate: (harness: RegistryHarness) => harness.setPresent(false),
    },
    { label: "ambiguous inspection", mutate: (harness: RegistryHarness) => harness.setCopies(2) },
    { label: "malformed inspection", mutate: (harness: RegistryHarness) => harness.setOutput("{") },
  ])("rejects post-start $label without settlement retry", ({ mutate }) => {
    const harness = createRegistryHarness(false);
    const clock = createFakeTiming();
    harness.setAfterStartInspect(() => mutate(harness));

    expect(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
        clock.timing,
      ),
    ).toThrow();
    expect(clock.sleeps).toEqual([]);
    expect(harness.calls.filter((args) => args[0] === "start")).toHaveLength(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "rejects an invalid initial settlement clock sample %s",
    (value) => {
      const harness = createRegistryHarness(false);

      const error = captureRegistryPhase(() =>
        preparePortableRegistryRecovery(
          harness.engine as never,
          harness.expectedAuthoritySha256,
          vi.fn(),
          vi.fn(),
          { now: () => value, sleep: vi.fn() },
        ),
      );
      expect(error.phase).toBe("PENDING_DEADLINE");
      expect(harness.calls.filter((args) => args[0] === "start")).toHaveLength(1);
      expect(harness.isRunning()).toBe(false);
    },
  );

  it("rejects a backward settlement clock before another observation", () => {
    const harness = createRegistryHarness(false);
    const samples = [1, 0];
    const sleep = vi.fn();
    harness.setStartIp("");

    const error = captureRegistryPhase(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
        { now: () => samples.shift() ?? 0, sleep },
      ),
    );
    expect(error.phase).toBe("PENDING_DEADLINE");
    expect(sleep).not.toHaveBeenCalled();
    expect(harness.isRunning()).toBe(false);
  });

  it.each([
    {
      owner: "caller",
      assertFailure: (operation: () => unknown) => expect(operation).toThrow("authority drift"),
    },
    {
      owner: "engine",
      assertFailure: (operation: () => unknown) =>
        expect(captureRegistryPhase(operation).phase).toBe("SETTLEMENT_CURRENTNESS"),
    },
  ])("rejects $owner authority drift during settlement", ({ owner, assertFailure }) => {
    const harness = createRegistryHarness(false);
    const clock = createFakeTiming();
    const caller = vi.fn();
    const engine = vi.fn();
    const selected = owner === "caller" ? caller : engine;
    Array.from({ length: 3 }).forEach(() => selected.mockImplementationOnce(() => undefined));
    selected.mockImplementationOnce(() => {
      throw new Error("authority drift");
    });
    harness.setStartIp("");

    const operation = () =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        engine,
        caller,
        clock.timing,
      );
    assertFailure(operation);
    expect(clock.sleeps).toEqual([1_000]);
    expect(harness.calls.filter((args) => args[0] === "start")).toHaveLength(1);
    expect(harness.calls).toContainEqual(["stop", "--time", "10", REGISTRY_ID]);
  });

  it("keeps a timed-out start terminal when the pinned registry remains stopped", () => {
    const harness = createRegistryHarness(false);
    harness.setStartTimeout(false);

    const error = captureRegistryPhase(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    );
    expect(error.phase).toBe("POSTCONDITION");
    expect(harness.isRunning()).toBe(false);
  });

  it("classifies a timed-out start with a foreign registry IP address", () => {
    const harness = createRegistryHarness(false);
    harness.setStartTimeout(true);
    harness.setStartIp("10.87.0.99");

    const error = captureRegistryPhase(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    );
    expect(error.phase).toBe("PINNED_REGISTRY_INSPECTION");
    expect(harness.isRunning()).toBe(false);
  });

  it("accepts an ordinary command error after proving the exact registry running", () => {
    const harness = createRegistryHarness(false);
    harness.setStartError("EIO", true);

    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );

    expect(prepared.started).toBe(true);
    expect(harness.isRunning()).toBe(true);
    expect(harness.calls.some((args) => args[0] === "stop")).toBe(false);
  });

  it.each([
    {
      label: "nonzero result",
      configure: (harness: RegistryHarness) =>
        harness.setStartOutcome({ status: 125, changesState: false }),
    },
    {
      label: "ordinary command error",
      configure: (harness: RegistryHarness) => harness.setStartError("EIO", false),
    },
  ])("rejects a $label when the exact registry remains stopped", ({ configure }) => {
    const harness = createRegistryHarness(false);
    configure(harness);

    const error = captureRegistryPhase(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    );
    expect(error.phase).toBe("POSTCONDITION");
    expect(harness.isRunning()).toBe(false);
  });

  it("rejects a thrown start capture after proving the exact registry stayed stopped", () => {
    const harness = createRegistryHarness(false);
    harness.setStartThrows();

    const error = captureRegistryPhase(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    );
    expect(error.phase).toBe("START_DISPATCH");
    expect(error.message).not.toContain("registry capture failed");
    expect(harness.isRunning()).toBe(false);
    const startIndex = harness.calls.findIndex((args) => args[0] === "start");
    expect(
      harness.calls
        .slice(startIndex + 1)
        .some((args) => args[0] === "network" || args[0] === "container"),
    ).toBe(true);
    expect(harness.calls.filter((args) => args[0] === "stop")).toHaveLength(0);
    expect(harness.calls.filter((args) => args[0] === "start")).toHaveLength(1);
  });

  it("restores a registry when start dispatch throws after the exact mutation", () => {
    const harness = createRegistryHarness(false);
    harness.setAfterStart(() => {
      throw new Error("after-dispatch authority canary");
    });

    const error = captureRegistryPhase(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    );
    expect(error.phase).toBe("START_DISPATCH");
    expect(error.message).not.toContain("after-dispatch authority canary");
    expect(harness.isRunning()).toBe(false);
    expect(harness.calls).toContainEqual(["stop", "--time", "10", REGISTRY_ID]);
  });

  it("reports restoration uncertainty when post-mutation start dispatch rollback fails", () => {
    const harness = createRegistryHarness(false);
    harness.setAfterStart(() => {
      throw new Error("after-dispatch authority canary");
    });
    harness.setStopStatus(125);

    expect(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    ).toThrow(PortableRegistryRecoveryRestorationError);
    expect(harness.isRunning()).toBe(true);
  });

  it("classifies one failed post-start network inspection without disclosing its output", () => {
    const harness = createRegistryHarness(false);
    harness.setPostStartNetworkFailures(1);

    const error = captureRegistryPhase(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    );
    expect(error.phase).toBe("NETWORK_INSPECTION");
    expect(error.message).not.toContain("network canary");
    expect(harness.isRunning()).toBe(false);
  });

  it("classifies one malformed pinned-registry inspection before rollback", () => {
    const harness = createRegistryHarness(false);
    const injectMalformedOutput = vi.fn().mockImplementationOnce(() => {
      harness.setNextOutput("nested registry output canary");
    });
    harness.setAfterStartInspect(injectMalformedOutput);

    const error = captureRegistryPhase(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    );
    expect(error.phase).toBe("PINNED_REGISTRY_INSPECTION");
    expect(error.message).not.toContain("nested registry output canary");
    expect(harness.isRunning()).toBe(false);
  });

  it("reports restoration uncertainty instead of the failed postcondition", () => {
    const harness = createRegistryHarness(false);
    harness.setStartLabel("changed");
    harness.setStopStatus(125);

    expect(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    ).toThrow(PortableRegistryRecoveryRestorationError);
  });

  it("rolls back an exact running registry when an ordinary error has authority drift", () => {
    const harness = createRegistryHarness(false);
    harness.setStartError("EIO", true);
    harness.setStartLabel("changed");

    expect(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    ).toThrow();
    expect(harness.isRunning()).toBe(false);
    expect(harness.calls).toContainEqual(["stop", "--time", "10", REGISTRY_ID]);
  });

  it("rejects authority drift after accepting a timed-out exact start", () => {
    const harness = createRegistryHarness(false);
    harness.setStartTimeout(true);
    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );
    harness.setLabel("changed");

    expect(() => prepared.assertCurrent()).toThrow();
    expect(() => prepared.rollback()).toThrow();
    expect(harness.isRunning()).toBe(false);
  });

  it("stops the pinned registry before reporting post-start authority drift", () => {
    const harness = createRegistryHarness(false);
    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );
    harness.setLabel("changed");

    expect(() => prepared.rollback()).toThrow();
    expect(harness.isRunning()).toBe(false);
    expect(harness.calls).toContainEqual(["stop", "--time", "10", REGISTRY_ID]);
  });
});
