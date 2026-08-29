// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesPortableForwardRecoveryInput } from "../../src/lib/actions/sandbox/probe/hermes-portable-forward-recovery";
import type { ConnectHarness } from "./connect-flow-test-harness";

type ForwardRecord = {
  owner: string;
  reachable: boolean;
  status: "active" | "dead" | "running" | "stopped";
};

function forwardList(records: ReadonlyMap<number, ForwardRecord>): string {
  return [
    "SANDBOX BIND PORT PID STATUS",
    ...[...records].map(
      ([port, record]) => `${record.owner} 127.0.0.1 ${String(port)} 12345 ${record.status}`,
    ),
  ].join("\n");
}

export function createHermesPortableForwardRecoveryFixture({
  ports = [18_789],
  active = [],
  dead = [],
  running = [],
  stopped = [],
  occupied = [],
  malformedList = false,
  listStatus = 0,
  startStatus = 0,
  startUpdatesState = true,
  driftCurrentAfterStart = false,
  dropStartedPort,
  listOutput,
}: {
  ports?: readonly number[];
  active?: readonly number[];
  dead?: readonly number[];
  running?: readonly number[];
  stopped?: readonly number[];
  occupied?: readonly number[];
  malformedList?: boolean;
  listStatus?: number;
  startStatus?: number;
  startUpdatesState?: boolean;
  driftCurrentAfterStart?: boolean;
  dropStartedPort?: number;
  listOutput?: string;
} = {}) {
  const records = new Map<number, ForwardRecord>();
  for (const port of active) {
    records.set(port, { owner: "alpha", reachable: true, status: "active" });
  }
  for (const port of dead) {
    records.set(port, { owner: "alpha", reachable: false, status: "dead" });
  }
  for (const port of running) {
    records.set(port, { owner: "alpha", reachable: true, status: "running" });
  }
  for (const port of stopped) {
    records.set(port, { owner: "alpha", reachable: false, status: "stopped" });
  }
  for (const port of occupied) {
    records.set(port, { owner: "beta", reachable: true, status: "running" });
  }
  const currentCalls: string[][] = [];
  const rollbackCalls: string[][] = [];
  let currentAllowed = true;
  let rollbackAllowed = true;
  let now = 0;

  const capture = (args: readonly string[], rollback: boolean) => {
    const calls = rollback ? rollbackCalls : currentCalls;
    calls.push([...args]);
    if (args[0] === "forward" && args[1] === "list") {
      return {
        status: listStatus,
        output: listOutput ?? (malformedList ? "not a forward list" : forwardList(records)),
      };
    }
    const port = Number(args[1] === "stop" ? args[2] : args[3]);
    if (args[1] === "stop") {
      records.delete(port);
      return { status: 0, output: "" };
    }
    if (args[1] === "start") {
      if (startUpdatesState) {
        records.set(port, { owner: "alpha", reachable: true, status: "running" });
      }
      if (port === dropStartedPort) records.delete(port);
      if (driftCurrentAfterStart) currentAllowed = false;
      return { status: startStatus, output: "" };
    }
    throw new Error("unexpected command");
  };
  const input: HermesPortableForwardRecoveryInput = {
    intent: "connect-probe-only",
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    operationTimeoutMs: 30_000,
    ports,
    probeTimeoutMs: 10_000,
    deps: {
      assertCurrent: () => {
        if (!currentAllowed) throw new Error("current authority canary");
      },
      assertRollbackCurrent: () => {
        if (!rollbackAllowed) throw new Error("rollback authority canary");
      },
      captureCurrent: (args) => capture(args, false),
      captureRollback: (args) => capture(args, true),
      isPortReachable: (port) => records.get(port)?.reachable === true,
      now: () => now,
      sleep: (milliseconds) => {
        now += milliseconds;
      },
    },
  };
  return {
    currentCalls,
    elapsedMs: () => now,
    input,
    records,
    rollbackCalls,
    setCurrentAllowed(value: boolean) {
      currentAllowed = value;
    },
    setRollbackAllowed(value: boolean) {
      rollbackAllowed = value;
    },
  };
}

export function configureMissingHermesForwardCapture(
  harness: ConnectHarness,
  options: {
    readonly afterStart?: () => void;
    readonly initialStatus?: "dead" | "missing";
  } = {},
): { readonly isRunning: () => boolean } {
  let forwardStatus: "dead" | "missing" | "running" = options.initialStatus ?? "missing";
  const captureResolved = harness.captureResolvedOpenshellSpy.getMockImplementation()!;
  harness.spawnSyncSpy.mockImplementation(((command: unknown) => ({
    status: String(command) === process.execPath && forwardStatus !== "running" ? 1 : 0,
    signal: null,
  })) as never);
  harness.captureResolvedOpenshellSpy.mockImplementation(((
    args: unknown,
    captureOptions: unknown,
  ) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    if (argv[0] === "forward" && argv[1] === "list") {
      return {
        status: 0,
        output:
          forwardStatus === "missing"
            ? "SANDBOX BIND PORT PID STATUS"
            : `SANDBOX BIND PORT PID STATUS\nalpha 127.0.0.1 18789 12345 ${forwardStatus}`,
      };
    }
    if (argv[0] === "forward" && argv[1] === "stop") {
      forwardStatus = "missing";
      return { status: 0, output: "" };
    }
    if (argv[0] === "forward" && argv[1] === "start") {
      forwardStatus = "running";
      options.afterStart?.();
      return { status: 0, output: "" };
    }
    return captureResolved(args, captureOptions);
  }) as never);
  return { isRunning: () => forwardStatus === "running" };
}
