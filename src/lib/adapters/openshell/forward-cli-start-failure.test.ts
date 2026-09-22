// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { formatOpenShellForwardStartFailure, type OpenShellForwardStartFailure } from "./forward";
import {
  createHarness,
  errors,
  forward,
  type ForwardChild,
  type InspectListener,
  type ProbePort,
} from "./forward-cli-test-fixture";

type StartFailureHarness = Pick<ReturnType<typeof createHarness>, "adapter" | "terminate">;
type StartFailureCase = Readonly<{
  mode: string;
  failure: OpenShellForwardStartFailure;
  terminationCount: number;
  harness(): StartFailureHarness;
}>;

function eventChild(events: EventEmitter): ForwardChild {
  return {
    exitCode: null,
    off: events.off.bind(events),
    on: events.on.bind(events),
    once: events.once.bind(events),
    pid: 4_321,
    signalCode: null,
    unref: vi.fn(),
  } as unknown as ForwardChild;
}

function neverSettles(): Promise<void> {
  return new Promise(() => undefined);
}

function childEventHarness(emitFailure: (events: EventEmitter) => void): () => StartFailureHarness {
  return () => {
    const events = new EventEmitter();
    const child = eventChild(events);
    return createHarness({
      spawn: () => child,
      sleep: async () => {
        emitFailure(events);
        await neverSettles();
      },
    });
  };
}

function listenerFailureHarness(): StartFailureHarness {
  const events = new EventEmitter();
  const child = {
    exitCode: null,
    off: events.off.bind(events),
    on: events.on.bind(events),
    once: () => {
      throw new Error("private listener diagnostic");
    },
    pid: 4_321,
    signalCode: null,
    unref: vi.fn(),
  } as unknown as ForwardChild;
  return createHarness({ spawn: () => child });
}

function inspectionExitHarness(): StartFailureHarness {
  const events = new EventEmitter();
  const child = eventChild(events);
  const inspect = vi
    .fn<InspectListener>()
    .mockResolvedValueOnce({ state: "unbound" })
    .mockImplementationOnce(async () => {
      events.emit("exit", 18, null);
      return { state: "foreign", pids: [9_876] };
    });
  return createHarness({ inspect, spawn: () => child });
}

function probeFailureHarness(): StartFailureHarness {
  const inspect = vi
    .fn<InspectListener>()
    .mockResolvedValueOnce({ state: "unbound" })
    .mockResolvedValueOnce({ state: "owned", pid: 4_321 });
  const probePort = vi
    .fn<ProbePort>()
    .mockResolvedValueOnce({ state: "unbound" })
    .mockResolvedValueOnce({ state: "indeterminate", error: errors.transport })
    .mockResolvedValueOnce({ state: "unbound" });
  return createHarness({ inspect, probePort });
}

const cases: readonly StartFailureCase[] = [
  {
    mode: "spawn throws",
    failure: { stage: "spawn", reason: "invocation_failed" },
    terminationCount: 0,
    harness: () =>
      createHarness({
        spawn: () => {
          throw new Error("private invocation diagnostic");
        },
      }),
  },
  {
    mode: "the executable is absent",
    failure: { stage: "spawn", reason: "executable_not_found" },
    terminationCount: 0,
    harness: () =>
      createHarness({
        spawn: () => {
          throw Object.assign(new Error("private invocation diagnostic"), { code: "ENOENT" });
        },
      }),
  },
  {
    mode: "the executable is not permitted with EACCES",
    failure: { stage: "spawn", reason: "permission_denied" },
    terminationCount: 0,
    harness: () =>
      createHarness({
        spawn: () => {
          throw Object.assign(new Error("private invocation diagnostic"), { code: "EACCES" });
        },
      }),
  },
  {
    mode: "the executable is not permitted with EPERM",
    failure: { stage: "spawn", reason: "permission_denied" },
    terminationCount: 0,
    harness: () =>
      createHarness({
        spawn: () => {
          throw Object.assign(new Error("private invocation diagnostic"), { code: "EPERM" });
        },
      }),
  },
  {
    mode: "the child reports an operation permission error",
    failure: { stage: "spawn", reason: "permission_denied" },
    terminationCount: 1,
    harness: childEventHarness((events) =>
      events.emit("error", Object.assign(new Error("private child diagnostic"), { code: "EPERM" })),
    ),
  },
  {
    mode: "a child listener cannot be installed",
    failure: { stage: "spawn", reason: "listener_registration_failed" },
    terminationCount: 1,
    harness: listenerFailureHarness,
  },
  {
    mode: "the child exits",
    failure: { stage: "startup", reason: "child_exited", exitStatus: 17 },
    terminationCount: 1,
    harness: childEventHarness((events) => events.emit("exit", 17, null)),
  },
  {
    mode: "a child error precedes its exit",
    failure: { stage: "spawn", reason: "child_error" },
    terminationCount: 1,
    harness: childEventHarness((events) => {
      events.emit("error", new Error("private child diagnostic"));
      events.emit("exit", 19, null);
    }),
  },
  {
    mode: "a child exit precedes its error",
    failure: { stage: "startup", reason: "child_exited", exitStatus: 19 },
    terminationCount: 1,
    harness: childEventHarness((events) => {
      events.emit("exit", 19, null);
      events.emit("error", new Error("private child diagnostic"));
    }),
  },
  {
    mode: "the child exits during ownership inspection",
    failure: { stage: "startup", reason: "child_exited", exitStatus: 18 },
    terminationCount: 1,
    harness: inspectionExitHarness,
  },
  {
    mode: "the child receives a signal",
    failure: { stage: "startup", reason: "child_signaled", signal: "SIGTERM" },
    terminationCount: 1,
    harness: childEventHarness((events) => events.emit("exit", null, "SIGTERM")),
  },
  {
    mode: "the reachability probe fails",
    failure: { stage: "reachability", reason: "probe_failed" },
    terminationCount: 1,
    harness: probeFailureHarness,
  },
];

describe("CLI OpenShell direct forward startup failures", () => {
  it.each(cases)("classifies startup failure when $mode (#9808)", async (testCase) => {
    const { adapter, terminate } = testCase.harness();

    const result = await adapter.startForward({ forward });

    expect(result).toEqual({
      state: "failed",
      forward,
      effect: "none",
      error: errors.transport,
      failure: testCase.failure,
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(terminate).toHaveBeenCalledTimes(testCase.terminationCount);
  });

  it("preserves a child exit recorded as the polling deadline expires", async () => {
    const events = new EventEmitter();
    const child = eventChild(events);
    let time = 0;
    const { adapter, terminate } = createHarness({
      now: () => time,
      spawn: () => child,
      sleep: async () => {
        time = 19;
        events.emit("exit", 17, null);
        time = 20;
      },
    });

    await expect(adapter.startForward({ forward, timeoutMs: 20 })).resolves.toEqual({
      state: "failed",
      forward,
      effect: "none",
      error: errors.timeout,
      failure: { stage: "startup", reason: "child_exited", exitStatus: 17 },
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("preserves a child exit recorded as the post-spawn fence reaches its deadline", async () => {
    const events = new EventEmitter();
    const child = eventChild(events);
    let time = 0;
    let afterFence = () => undefined;
    const assertCurrent = vi.fn(async () => {
      afterFence();
    });
    const { adapter, terminate } = createHarness({
      now: () => time,
      spawn: () => {
        afterFence = () => {
          afterFence = () => undefined;
          time = 19;
          events.emit("exit", 17, null);
          time = 20;
        };
        return child;
      },
    });

    await expect(adapter.startForward({ forward, timeoutMs: 20, assertCurrent })).resolves.toEqual({
      state: "failed",
      forward,
      effect: "none",
      error: errors.timeout,
      failure: { stage: "startup", reason: "child_exited", exitStatus: 17 },
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it.each([
    {
      failure: { stage: "startup", reason: "child_exited", exitStatus: 17 } as const,
      formatted: "forward-start startup/child_exited status=17",
      mode: "a child exits",
    },
    {
      failure: { stage: "startup", reason: "child_signaled", signal: "SIGTERM" } as const,
      formatted: "forward-start startup/child_signaled signal=SIGTERM",
      mode: "a child receives a signal",
    },
    {
      failure: { stage: "startup", reason: "child_exited" } as const,
      formatted: "forward-start startup/child_exited",
      mode: "an exit classification has no optional value",
    },
    {
      failure: { stage: "startup", reason: "child_signaled" } as const,
      formatted: "forward-start startup/child_signaled",
      mode: "a signal classification has no optional value",
    },
  ])("formats the startup failure when $mode", ({ failure, formatted }) => {
    expect(formatOpenShellForwardStartFailure(failure)).toBe(formatted);
  });
});
