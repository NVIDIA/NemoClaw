// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createPodmanManagedGatewayWatcherController,
  type PodmanGatewayWatcherSnapshot,
  type PodmanManagedGatewayWatcherControllerDeps,
} from "./watcher-controller";

const ORIGINAL = Object.freeze({
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  launchIdentity: "launch-sha256",
  ownerIdentity: "service-unit-sha256",
  ownerKind: "managed-service",
  pid: 4100,
  processStartIdentity: "proc-start-100",
} as const satisfies PodmanGatewayWatcherSnapshot);

const RESUMED = Object.freeze({
  ...ORIGINAL,
  pid: 4200,
  processStartIdentity: "proc-start-200",
} as const satisfies PodmanGatewayWatcherSnapshot);

function harness(overrides: Partial<PodmanManagedGatewayWatcherControllerDeps> = {}) {
  let ownerStopped = false;
  let watchers: PodmanGatewayWatcherSnapshot[] = [ORIGINAL];
  const alive = new Set(["4100:proc-start-100"]);
  const healthy = new Set(["4100:proc-start-100"]);
  const key = (entry: PodmanGatewayWatcherSnapshot) =>
    `${String(entry.pid)}:${entry.processStartIdentity}`;
  const stopExactOwner = vi.fn((entry: PodmanGatewayWatcherSnapshot) => {
    expect(entry).toEqual(ORIGINAL);
    alive.delete(key(entry));
    healthy.delete(key(entry));
    watchers = [];
    ownerStopped = true;
  });
  const resumeSameOwner = vi.fn(() => {
    ownerStopped = false;
    watchers = [RESUMED];
    alive.add(key(RESUMED));
    healthy.add(key(RESUMED));
  });
  const deps: PodmanManagedGatewayWatcherControllerDeps = {
    captureCurrent: () => ORIGINAL,
    listTargetWatchers: () => watchers,
    isProcessInstanceAlive: (entry) => alive.has(key(entry)),
    isOwnerStopped: () => ownerStopped,
    stopExactOwner,
    resumeSameOwner,
    isHealthy: (entry) => healthy.has(key(entry)),
    now: (() => {
      let now = 0;
      return () => now;
    })(),
    resumePollIntervalMs: 0,
    resumeTimeoutMs: 1_000,
    sleep: () => {},
    ...overrides,
  };
  return {
    alive,
    controller: createPodmanManagedGatewayWatcherController(deps),
    deps,
    healthy,
    ownerStopped: () => ownerStopped,
    resumeSameOwner,
    setOwnerStopped: (value: boolean) => {
      ownerStopped = value;
    },
    setWatchers: (value: PodmanGatewayWatcherSnapshot[]) => {
      watchers = value;
    },
    stopExactOwner,
    watchers: () => watchers,
  };
}

describe("Podman managed host gateway watcher controller", () => {
  it("holds an opaque stopped-owner lease and resumes the same launch identity healthy", () => {
    const fake = harness();
    const lease = fake.controller.quiesceAndProve();

    expect(fake.stopExactOwner).toHaveBeenCalledOnce();
    expect(fake.ownerStopped()).toBe(true);
    expect(fake.watchers()).toEqual([]);
    lease.assertStillStopped();
    lease.assertStillStopped();

    lease.resumeAndProve();
    expect(fake.resumeSameOwner).toHaveBeenCalledOnce();
    expect(fake.watchers()).toEqual([RESUMED]);
    expect(fake.ownerStopped()).toBe(false);
    expect(() => lease.assertStillStopped()).toThrow("already been released");
  });

  it("refuses an ambiguous target before asking any owner to stop", () => {
    const fake = harness({
      listTargetWatchers: () => [
        ORIGINAL,
        { ...ORIGINAL, pid: 4101, processStartIdentity: "proc-start-101" },
      ],
    });

    expect(() => fake.controller.quiesceAndProve()).toThrow("exactly one target-bound");
    expect(fake.stopExactOwner).not.toHaveBeenCalled();
  });

  it("refuses a captured watcher that is not healthy before cutover", () => {
    const fake = harness({ isHealthy: () => false });

    expect(() => fake.controller.quiesceAndProve()).toThrow("not healthy before cutover");
    expect(fake.stopExactOwner).not.toHaveBeenCalled();
  });

  it("detects a service respawn under the lease and does not launch a duplicate", () => {
    const fake = harness();
    const lease = fake.controller.quiesceAndProve();
    fake.setOwnerStopped(false);
    fake.setWatchers([RESUMED]);
    fake.alive.add("4200:proc-start-200");
    fake.healthy.add("4200:proc-start-200");

    expect(() => lease.assertStillStopped()).toThrow("lifecycle owner is not proven stopped");
    expect(fake.resumeSameOwner).not.toHaveBeenCalled();
    expect(fake.watchers()).toEqual([RESUMED]);
  });

  it("does not restart a stopped owner over an unexplained target watcher", () => {
    const fake = harness();
    const lease = fake.controller.quiesceAndProve();
    fake.setWatchers([RESUMED]);
    fake.alive.add("4200:proc-start-200");
    fake.healthy.add("4200:proc-start-200");

    expect(() => lease.resumeAndProve()).toThrow("watcher appeared while the stop lease was held");
    expect(fake.resumeSameOwner).not.toHaveBeenCalled();
  });

  it("fails closed when resume produces a different launch identity", () => {
    const foreign = { ...RESUMED, launchIdentity: "different-launch" };
    const fake = harness({
      resumeSameOwner: () => {
        fake.setOwnerStopped(false);
        fake.setWatchers([foreign]);
        fake.alive.add("4200:proc-start-200");
        fake.healthy.add("4200:proc-start-200");
      },
    });
    const lease = fake.controller.quiesceAndProve();

    expect(() => lease.resumeAndProve()).toThrow("does not match the captured");
  });

  it("fails closed when the same resumed owner never becomes healthy", () => {
    const fake = harness({
      isHealthy: (entry) => entry.pid === ORIGINAL.pid,
      resumeSameOwner: () => {
        fake.setOwnerStopped(false);
        fake.setWatchers([RESUMED]);
        fake.alive.add("4200:proc-start-200");
      },
    });
    const lease = fake.controller.quiesceAndProve();

    expect(() => lease.resumeAndProve()).toThrow("did not resume one exact healthy");
  });

  it("accepts independent exact health proof when the resume command loses its reply", () => {
    const fake = harness({
      resumeSameOwner: () => {
        fake.setOwnerStopped(false);
        fake.setWatchers([RESUMED]);
        fake.alive.add("4200:proc-start-200");
        fake.healthy.add("4200:proc-start-200");
        throw new Error("service-manager reply lost");
      },
    });
    const lease = fake.controller.quiesceAndProve();

    expect(() => lease.resumeAndProve()).not.toThrow();
    expect(fake.watchers()).toEqual([RESUMED]);
  });

  it("restores the exact watcher itself when the owner stop operation throws", () => {
    const fake = harness({
      stopExactOwner: () => {
        fake.alive.delete("4100:proc-start-100");
        fake.healthy.delete("4100:proc-start-100");
        fake.setWatchers([]);
        fake.setOwnerStopped(true);
        throw new Error("systemctl stop lost its reply");
      },
    });

    expect(() => fake.controller.quiesceAndProve()).toThrow(
      "The exact captured watcher was restored",
    );
    expect(fake.resumeSameOwner).toHaveBeenCalledOnce();
    expect(fake.watchers()).toEqual([RESUMED]);
  });

  it("rejects target drift returned by watcher enumeration", () => {
    const fake = harness({
      listTargetWatchers: () => [{ ...ORIGINAL, gatewayPort: 8081 }],
    });

    expect(() => fake.controller.quiesceAndProve()).toThrow("different gateway target");
    expect(fake.stopExactOwner).not.toHaveBeenCalled();
  });
});
