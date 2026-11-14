// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  patchCommandSessionCaller,
  patchCommandTerminationSessionCleanup,
  patchScopedCommandSessionCleanup,
} from "../../../scripts/lib/openclaw-command-session-cleanup.mts";
import { harness } from "./support/private-broker-harness.ts";

const native = fs.readFileSync(
  new URL("./fixtures/scoped-command-cleanup-10.5.js.txt", import.meta.url),
  "utf8",
);
const nativeTermination = fs.readFileSync(
  new URL("./fixtures/command-termination-10.5.js.txt", import.meta.url),
  "utf8",
);

function terminationController(options: Parameters<typeof harness>[0] = {}, admitted = true) {
  const subject = harness(options);
  let clock = 0;
  let birth: string | null = "original";
  let onSignal = () => {};
  const signals: Array<[number, string]> = [];
  const forces: number[] = [];
  const process = {
    ...subject.globals.process,
    kill(pid: number, signal: string) {
      signals.push([pid, signal]);
      onSignal();
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    },
  };
  const params = {
    child: { pid: 200, exitCode: 0, signalCode: null },
    processTree: { mode: "graceful" },
    nemoclawPrivateSession: admitted,
    killGraceMs: 300,
    isChildExited: () => true,
    isCommandSettled: () => true,
    cancelController: new AbortController(),
  };
  const context = {
    ...subject.globals,
    process,
    params,
    Date: { now: () => clock },
    sleep: async (delay: number) => {
      clock += delay;
    },
    setTimeout: (callback: () => void, delay: number) => {
      clock += delay;
      callback();
    },
    constants: { signals: { SIGKILL: 9 } },
    COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS: 10_000,
    getFileLockProcessStartTime: () => birth,
    isChildProcessTreeAlive: () => true,
    killProcessTree: (pid: number) => {
      forces.push(pid);
    },
    scheduleAdoptedChildZombieReapAfterExit: () => {},
  };
  const controller = vm.runInNewContext(
    patchCommandTerminationSessionCleanup(nativeTermination, native) +
      "; createCommandTerminationController(params)",
    context,
  ) as { terminate(): boolean; settle(): Promise<string> };
  return {
    ...subject,
    controller,
    signals,
    forces,
    elapsed: () => clock,
    replacePid: () => {
      birth = "replacement";
    },
    onSignal: (callback: () => void) => {
      onSignal = callback;
    },
  };
}

function scopedCommand(options: Parameters<typeof harness>[0] = {}, sandbox = true) {
  const subject = harness(options);
  let clock = 0;
  let settled = 0;
  let probes = 0;
  let birth: string | null = "original";
  const signals: number[] = [];
  const scope: {
    children: Set<{ stop(): void; settle(): Promise<void> }>;
    signal: AbortSignal;
    failure?: { error: unknown };
  } = { children: new Set(), signal: new AbortController().signal };
  const nodeChild = Object.assign(new EventEmitter(), { pid: 200, exitCode: 0, signalCode: null });
  const child = Object.assign(Promise.resolve(), { pid: 200, nodeChildProcess: nodeChild });
  const context = {
    ...subject.globals,
    process: { ...subject.globals.process, env: { OPENSHELL_SANDBOX: sandbox ? "1" : "0" } },
    Date: { now: () => clock },
    sleep: async (delay: number) => {
      clock += delay;
    },
    COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS: 10_000,
    BrokerChild: class {},
    commandAdmissions: new WeakMap(),
    CommandProcessCleanupError: class extends Error {},
    getFileLockProcessStartTime: () => birth,
    getProcessInstanceStartTime: () => 12,
    isChildProcessTreeAlive: () => {
      probes++;
      return true;
    },
    killProcessTree: (pid: number) => {
      signals.push(pid);
    },
    scheduleAdoptedChildZombieReapAfterExit: () => {},
    scope,
    child,
    reservation: {
      spawned: () => {},
      settled: () => {
        settled++;
      },
    },
  };
  vm.runInNewContext(
    patchScopedCommandSessionCleanup(native) + "; retainCommandProcess(scope, child, reservation)",
    context,
  );
  const owned = [...scope.children][0]!;
  return {
    ...subject,
    scope,
    owned,
    signals,
    settled: () => settled,
    probes: () => probes,
    elapsed: () => clock,
    replacePid: () => {
      birth = "replacement";
    },
  };
}

describe("scoped command session cleanup", () => {
  it("settles an absent owned session when group signals are denied", async () => {
    const subject = scopedCommand();
    await subject.owned.settle();
    expect(subject.settled()).toBe(1);
    expect(subject.probes()).toBe(0);
    expect(subject.signals).toEqual([]);
    expect(subject.scope.failure).toBeUndefined();
  });

  it("keeps native termination and the exit deadline while a descendant survives", async () => {
    const subject = scopedCommand();
    subject.addProcess(201, 200);
    subject.owned.stop();
    await expect(subject.owned.settle()).rejects.toBeInstanceOf(Error);
    expect(subject.signals).toEqual([200]);
    expect(subject.elapsed()).toBe(10_000);
    expect(subject.settled()).toBe(0);
  });

  it("retains inventory failure and refuses custody settlement", async () => {
    const subject = scopedCommand({ mountOptions: "hidepid=2" });
    await expect(subject.owned.settle()).rejects.toBeInstanceOf(Error);
    expect(subject.scope.failure?.error).toMatchObject({
      message: "Private broker procfs mount hides processes",
    });
    expect(subject.settled()).toBe(0);
  });

  it("refuses settlement when the original PID was replaced", async () => {
    const subject = scopedCommand();
    subject.addProcess(201, 200);
    subject.replacePid();
    await expect(subject.owned.settle()).rejects.toBeInstanceOf(Error);
    expect(subject.elapsed()).toBe(0);
    expect(subject.settled()).toBe(0);
  });

  it("uses native liveness outside the OpenShell sandbox", async () => {
    const subject = scopedCommand({}, false);
    await expect(subject.owned.settle()).rejects.toBeInstanceOf(Error);
    expect(subject.probes()).toBeGreaterThan(0);
    expect(subject.elapsed()).toBe(10_000);
  });

  it("rejects changed ownership and incomplete patch materialization", () => {
    expect(() =>
      patchScopedCommandSessionCleanup(
        native.replace("killDescendants: true", "killDescendants: false"),
      ),
    ).toThrow("ownership");
    const patched = patchScopedCommandSessionCleanup(native);
    expect(patchScopedCommandSessionCleanup(patched)).toBe(patched);
    expect(() =>
      patchScopedCommandSessionCleanup(patched.replace("scope.failure ??= { error };", "")),
    ).toThrow();
  });
});

describe("detached command termination session cleanup", () => {
  it("settles an absent admitted session without sending a signal", async () => {
    const subject = terminationController();
    expect(subject.controller.terminate()).toBe(false);
    await expect(subject.controller.settle()).resolves.toBe("normal");
    expect(subject.signals).toEqual([]);
    expect(subject.forces).toEqual([]);
  });

  it("preserves native signals and both deadlines when an admitted descendant survives", async () => {
    const subject = terminationController();
    subject.addProcess(201, 200);
    expect(subject.controller.terminate()).toBe(true);
    await expect(subject.controller.settle()).resolves.toBe("uncertain");
    expect(subject.signals).toEqual([[-200, "SIGTERM"]]);
    expect(subject.forces).toEqual([200]);
    expect(subject.elapsed()).toBe(10_300);
  });

  it("keeps cleanup uncertain after a later inventory becomes readable", async () => {
    const subject = terminationController({ mountOptions: "hidepid=2" });
    subject.onSignal(() =>
      fs.writeFileSync(
        subject.root + "/self/mountinfo",
        "1 0 0:1 / /proc rw - proc proc rw,hidepid=0\n",
      ),
    );
    subject.controller.terminate();
    await expect(subject.controller.settle()).resolves.toBe("uncertain");
    expect(subject.forces).toEqual([]);
  });

  it("does not signal a replaced PID during forced cleanup", async () => {
    const subject = terminationController();
    subject.addProcess(201, 200);
    subject.replacePid();
    subject.controller.terminate();
    await expect(subject.controller.settle()).resolves.toBe("uncertain");
    expect(subject.forces).toEqual([]);
  });

  it("preserves native uncertainty for callers without private-session admission", async () => {
    const subject = terminationController({}, false);
    subject.controller.terminate();
    await expect(subject.controller.settle()).resolves.toBe("uncertain");
    expect(subject.forces).toEqual([200]);
    expect(subject.elapsed()).toBe(10_300);
  });

  it("rejects a caller whose detached spawn was changed", () => {
    expect(() =>
      patchCommandSessionCaller(
        nativeTermination.replace(
          'detached: Boolean(killProcessTree && process.platform !== "win32")',
          "detached: false",
        ),
      ),
    ).toThrow("detached command caller");
    const patched = patchCommandTerminationSessionCleanup(nativeTermination, native);
    expect(patchCommandTerminationSessionCleanup(patched, native)).toBe(patched);
    expect(() =>
      patchCommandTerminationSessionCleanup(
        patched.replace(
          'return nemoclawInventoryUncertain ? "uncertain" : cleanup;',
          "return cleanup;",
        ),
        native,
      ),
    ).toThrow();
  });
});
