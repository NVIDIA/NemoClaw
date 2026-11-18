// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BROKER_SESSION_PROBE_SOURCE } from "../../../scripts/lib/openclaw-broker-session-probe.mts";
import { patchBrokerPrivateSessionCleanup } from "../../../scripts/lib/patch-openclaw-container-restart.mts";
import {
  harness,
  nativeCleanupHarness,
  nativeCleanup,
  denyProcfsRead,
} from "./support/private-broker-harness.ts";

describe("OpenShell private broker session absence", () => {
  it("confirms an empty private session from a complete fork-stable census", () => {
    const subject = harness();
    subject.addProcess(300, 300, "a ) name ( with parentheses");
    expect(subject.probe(200)).toBe(true);
    expect(subject.signals()).toBe(0);
  });

  it.each([200, 201])("refuses absence while private session member %s remains", (pid) => {
    const subject = harness();
    subject.addProcess(pid, 200);
    expect(subject.probe(200)).toBe(false);
    expect(subject.signals()).toBe(0);
  });

  it("refuses absence when a fork can create an unseen session member", () => {
    const subject = harness({ secondForkCount: "processes 42\n" });
    expect(subject.probe(200)).toBe(false);
  });

  it.each([0, 1, -200, 42, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid private session identity %s before inspecting processes",
    (identity) => {
      const subject = harness({
        open: () => {
          throw new Error("Unexpected filesystem read");
        },
      });
      expect(() => subject.probe(identity)).toThrow("Invalid private broker session identity");
    },
  );

  it("rejects a procfs view from another PID namespace", () => {
    const subject = harness({ namespace: "NSpid:\t1000\t42\n" });
    expect(() => subject.probe(200)).toThrow("wrong PID namespace");
  });

  it("rejects a filesystem that cannot provide a procfs census", () => {
    const subject = harness({ filesystemType: 0x01021994 });
    expect(() => subject.probe(200)).toThrow("requires procfs");
  });

  it.each(["hidepid=1", "hidepid=2", "hidepid=invisible"])(
    "rejects an incomplete census under %s",
    (mountOptions) => {
      const subject = harness({ mountOptions });
      expect(() => subject.probe(200)).toThrow("hides processes");
    },
  );

  it("rejects an unreadable member instead of assuming that member is absent", () => {
    const subject = harness({
      open: denyProcfsRead("/proc/300/stat"),
    });
    subject.addProcess(300, 300);
    expect(() => subject.probe(200)).toThrow("denied");
  });

  it("rejects symlinked process state", () => {
    const subject = harness();
    subject.addProcess(300, 300);
    fs.unlinkSync(path.join(subject.root, "300/stat"));
    fs.symlinkSync(path.join(subject.root, "stat"), path.join(subject.root, "300/stat"));
    expect(() => subject.probe(200)).toThrow();
  });

  it.each(["processes invalid\n", "processes 1\nprocesses 2\n", "cpu 0\n"])(
    "rejects an invalid kernel fork counter: %j",
    (counter) => {
      const subject = harness();
      fs.writeFileSync(path.join(subject.root, "stat"), counter);
      expect(() => subject.probe(200)).toThrow("no fork generation");
    },
  );

  it("rejects malformed process state", () => {
    const subject = harness();
    subject.addProcess(300, 300);
    fs.writeFileSync(path.join(subject.root, "300/stat"), "300 (worker) S 1 2 invalid\n");
    expect(() => subject.probe(200)).toThrow("Malformed procfs process session");
  });

  it("keeps a bounded inventory without declaring absence on timeout", () => {
    let clock = 0;
    const subject = harness({ now: () => (clock += 251) });
    expect(() => subject.probe(200)).toThrow("exceeded its bound");
  });
});

describe("native broker cleanup with the private session probe", () => {
  it("settles an absent private session without signals", async () => {
    const subject = nativeCleanupHarness();
    const cleanup = subject.cleanup();
    await expect(cleanup.settled).resolves.toBeUndefined();
    cleanup.force();
    expect(subject.signals).toEqual([]);
    expect(subject.elapsed()).toBe(0);
  });

  it("preserves native signals, deadline and failure when a session member survives", async () => {
    const subject = nativeCleanupHarness();
    subject.addProcess(201, 200);
    await expect(subject.cleanup().settled).rejects.toMatchObject({
      message: "Spawn broker group cleanup could not be confirmed for pgid=200",
      cause: { code: "EPERM" },
    });
    expect(subject.signals).toEqual([
      [-200, "SIGTERM"],
      [-200, "SIGKILL"],
    ]);
    expect(subject.elapsed()).toBe(7000);
  });

  it("rejects an incomplete census without reporting cleanup success", async () => {
    const subject = nativeCleanupHarness({ mountOptions: "hidepid=2" });
    await expect(subject.cleanup().settled).rejects.toMatchObject({
      message: "Spawn broker group cleanup could not be confirmed for pgid=200",
      cause: { message: "Private broker procfs mount hides processes" },
    });
    expect(subject.signals).toEqual([
      [-200, "SIGTERM"],
      [-200, "SIGKILL"],
    ]);
    expect(subject.elapsed()).toBe(7000);
  });

  it("retains an inventory error through the native force timer and cleanup promise", async () => {
    const subject = nativeCleanupHarness();
    subject.addProcess(201, 200);
    const wait = subject.environment.setTimeout$1;
    subject.environment.setTimeout$1 = async (delay) => {
      fs.writeFileSync(path.join(subject.root, "stat"), "cpu 0\n");
      await wait(delay);
    };
    await expect(subject.cleanup().settled).rejects.toMatchObject({
      message: "Spawn broker group cleanup could not be confirmed for pgid=200",
      cause: { message: "Private broker session inventory has no fork generation" },
    });
    expect(subject.signals).toEqual([
      [-200, "SIGTERM"],
      [-200, "SIGKILL"],
    ]);
    expect(subject.elapsed()).toBe(7000);
  });

  it.each([
    ["non-sandbox Linux", "0", "linux"],
    ["other platform", "1", "darwin"],
  ] as const)("retains the native probe on %s", async (_mode, sandboxFlag, platform) => {
    const subject = nativeCleanupHarness({
      open: () => {
        throw new Error("Unexpected procfs read");
      },
    });
    subject.environment.process.env.OPENSHELL_SANDBOX = sandboxFlag;
    subject.environment.process.platform = platform;
    let probes = 0;
    subject.environment.groupGone = () => {
      probes++;
      return true;
    };
    await expect(subject.cleanup().settled).resolves.toBeUndefined();
    expect(probes).toBe(1);
    expect(subject.signals).toEqual([]);
  });

  it("rejects pinned source drift and incomplete or duplicate patches", () => {
    const patched = patchBrokerPrivateSessionCleanup(nativeCleanup);
    expect(patchBrokerPrivateSessionCleanup(patched)).toBe(patched);
    expect(() =>
      patchBrokerPrivateSessionCleanup(
        nativeCleanup.replace('signal("SIGTERM")', 'signal("SIGKILL")'),
      ),
    ).toThrow("Unrecognized");
    expect(() => patchBrokerPrivateSessionCleanup(nativeCleanup + nativeCleanup)).toThrow(
      "Expected one",
    );
    expect(() =>
      patchBrokerPrivateSessionCleanup(
        nativeCleanup.replace("!detached || groupGone(pid)", "!detached"),
      ),
    ).toThrow("Unrecognized pinned lost-child");
    expect(() =>
      patchBrokerPrivateSessionCleanup(
        patched.replace("nemoclawPrivateBrokerSessionGone(pid)", "groupGone(pid)"),
      ),
    ).toThrow();
    expect(() =>
      patchBrokerPrivateSessionCleanup(
        patched.replace('process.env.OPENSHELL_SANDBOX !== "1"', "true"),
      ),
    ).toThrow();
    expect(() =>
      patchBrokerPrivateSessionCleanup(
        patched.replace("function nemoclawPrivateBrokerSessionGone", "function otherProbe"),
      ),
    ).toThrow("Incomplete");
    expect(() => patchBrokerPrivateSessionCleanup(patched + BROKER_SESSION_PROBE_SOURCE)).toThrow(
      "Incomplete",
    );
  });
});

describe("lost detached broker child cleanup", () => {
  it("settles a dead child only after its private session is absent", async () => {
    const subject = nativeCleanupHarness();
    const cleanup = subject.lostCleanup(true);
    await expect(cleanup.settled).resolves.toBeUndefined();
    expect(subject.terminations).toEqual([{ pid: 200, detached: true, graceMs: 5000 }]);
    cleanup.force();
    expect(subject.forced()).toBe(1);
    expect(subject.elapsed()).toBe(0);
  });

  it("fails at the native deadline when a detached session descendant survives", async () => {
    const subject = nativeCleanupHarness();
    subject.addProcess(201, 200);
    await expect(subject.lostCleanup(true).settled).rejects.toThrow(
      "Spawn broker child cleanup could not be confirmed for pid=200",
    );
    expect(subject.elapsed()).toBe(7000);
  });

  it("retains the separate direct-child death check", async () => {
    const subject = nativeCleanupHarness({
      open: () => {
        throw new Error("Unexpected procfs read");
      },
    });
    subject.environment.isPidDefinitelyDead = () => false;
    await expect(subject.lostCleanup(true).settled).rejects.toThrow(
      "Spawn broker child cleanup could not be confirmed for pid=200",
    );
    expect(subject.elapsed()).toBe(7000);
  });

  it("rejects an incomplete detached session inventory", async () => {
    const subject = nativeCleanupHarness({ mountOptions: "hidepid=2" });
    await expect(subject.lostCleanup(true).settled).rejects.toThrow("hides processes");
  });

  it("retains attached-child grace without using a private session probe", async () => {
    const subject = nativeCleanupHarness({
      open: () => {
        throw new Error("Unexpected procfs read");
      },
    });
    await expect(subject.lostCleanup(false).settled).resolves.toBeUndefined();
    expect(subject.terminations).toEqual([{ pid: 200, detached: false, graceMs: 5000 }]);
    expect(subject.elapsed()).toBe(5000);
  });

  it.each([
    ["non-sandbox Linux", "0", "linux"],
    ["other platform", "1", "darwin"],
  ] as const)(
    "retains the native detached-child group probe on %s",
    async (_mode, sandboxFlag, platform) => {
      const subject = nativeCleanupHarness({
        open: () => {
          throw new Error("Unexpected procfs read");
        },
      });
      subject.environment.process.env.OPENSHELL_SANDBOX = sandboxFlag;
      subject.environment.process.platform = platform;
      let probes = 0;
      subject.environment.groupGone = () => {
        probes++;
        return true;
      };
      await expect(subject.lostCleanup(true).settled).resolves.toBeUndefined();
      expect(probes).toBe(1);
    },
  );
});
