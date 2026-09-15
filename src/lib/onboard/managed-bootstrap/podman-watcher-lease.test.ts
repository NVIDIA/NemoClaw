// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createPodmanManagedGatewayWatcherController,
  PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
  PodmanGatewayWatcherLeaseError,
  type PodmanGatewayWatcherLeaseRecord,
  type PodmanGatewayWatcherSnapshot,
  type PodmanManagedGatewayWatcherControllerDeps,
} from "./podman-watcher-lease";

const LEASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_LEASE_ID = "22222222-2222-4222-8222-222222222222";
const ORIGINAL = Object.freeze({
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  launchIdentity: "launch-sha256",
  ownerIdentity: "service-unit-sha256",
  ownerKind: "managed-service",
  pid: 4_100,
  processStartIdentity: "proc-start-100",
} as const satisfies PodmanGatewayWatcherSnapshot);
const STANDALONE_ORIGINAL = Object.freeze({
  ...ORIGINAL,
  ownerKind: "standalone" as const,
});
const RESUMED = Object.freeze({
  ...ORIGINAL,
  pid: 4_200,
  processStartIdentity: "proc-start-200",
});
const RESUMED_AGAIN = Object.freeze({
  ...ORIGINAL,
  pid: 4_300,
  processStartIdentity: "proc-start-300",
});
const HOLDER = Object.freeze({ pid: 9_100, processStartIdentity: "holder-start-100" });

function record(
  phase: PodmanGatewayWatcherLeaseRecord["phase"] = "acquiring",
): PodmanGatewayWatcherLeaseRecord {
  return Object.freeze({
    ...ORIGINAL,
    schemaVersion: PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
    holder: HOLDER,
    leaseId: LEASE_ID,
    phase,
  });
}

function harness(
  overrides: Partial<PodmanManagedGatewayWatcherControllerDeps> = {},
  options: {
    readonly initial?: PodmanGatewayWatcherSnapshot;
    readonly retainQuiescedProcess?: boolean;
  } = {},
) {
  const initial = options.initial ?? ORIGINAL;
  let durable: PodmanGatewayWatcherLeaseRecord | null = null;
  let holderAlive = true;
  let ownerStopped = false;
  let resumeCount = 0;
  const key = (entry: PodmanGatewayWatcherSnapshot) =>
    `${String(entry.pid)}:${entry.processStartIdentity}`;
  let watchers: PodmanGatewayWatcherSnapshot[] = [initial];
  const alive = new Set([key(initial)]);
  const healthy = new Set([key(initial)]);
  const writes: PodmanGatewayWatcherLeaseRecord[] = [];
  const store = {
    read: vi.fn(() => durable),
    acquire: vi.fn((value: PodmanGatewayWatcherLeaseRecord) => {
      expect(durable, "lease already exists").toBeNull();
      durable = value;
      writes.push(value);
    }),
    advance: vi.fn((expectedLeaseId: string, value: PodmanGatewayWatcherLeaseRecord) => {
      expect(durable?.leaseId, "lease compare-and-swap failed").toBe(expectedLeaseId);
      durable = value;
      writes.push(value);
    }),
    clear: vi.fn((expectedLeaseId: string) => {
      expect(durable?.leaseId, "lease compare-and-clear failed").toBe(expectedLeaseId);
      durable = null;
    }),
  };
  const stopExactOwner = vi.fn((entry: PodmanGatewayWatcherSnapshot = initial) => {
    healthy.delete(key(entry));
    const stopByMode = {
      remove: () => {
        alive.delete(key(entry));
        watchers = [];
      },
      retain: () => undefined,
    } as const;
    stopByMode[options.retainQuiescedProcess === true ? "retain" : "remove"]();
    ownerStopped = true;
  });
  const resumeSameOwner = vi.fn(() => {
    const resumeByMode = {
      replace: () => {
        const resumed = resumeCount++ === 0 ? RESUMED : RESUMED_AGAIN;
        watchers = [resumed];
        alive.add(key(resumed));
        healthy.add(key(resumed));
      },
      retain: () => {
        const retained = watchers[0] as PodmanGatewayWatcherSnapshot;
        healthy.add(key(retained));
      },
    } as const;
    resumeByMode[options.retainQuiescedProcess === true ? "retain" : "replace"]();
    ownerStopped = false;
  });
  const deps: PodmanManagedGatewayWatcherControllerDeps = {
    store,
    captureCurrent: () => initial,
    captureLeaseHolder: () => HOLDER,
    listTargetWatchers: () => watchers,
    isProcessInstanceAlive: (entry) => alive.has(key(entry)),
    isLeaseHolderAlive: (holder) =>
      holderAlive &&
      holder.pid === HOLDER.pid &&
      holder.processStartIdentity === HOLDER.processStartIdentity,
    isOwnerStopped: () => ownerStopped,
    stopExactOwner,
    resumeSameOwner,
    isHealthy: (entry) => healthy.has(key(entry)),
    createLeaseId: () => LEASE_ID,
    now: () => 0,
    resumePollIntervalMs: 0,
    resumeTimeoutMs: 1_000,
    sleep: () => {},
    ...overrides,
  };
  return {
    alive,
    controller: createPodmanManagedGatewayWatcherController(deps),
    deps,
    durable: () => durable,
    healthy,
    ownerStopped: () => ownerStopped,
    resumeSameOwner,
    setDurable: (value: PodmanGatewayWatcherLeaseRecord | null) => {
      durable = value;
    },
    setHolderAlive: (value: boolean) => {
      holderAlive = value;
    },
    setOwnerStopped: (value: boolean) => {
      ownerStopped = value;
    },
    setWatchers: (value: PodmanGatewayWatcherSnapshot[]) => {
      watchers = value;
    },
    stopExactOwner,
    store,
    watchers: () => watchers,
    writes,
  };
}

describe("durable Podman OpenShell watcher lease", () => {
  it("persists authority before stop and clears it only after exact healthy resume", () => {
    const fake = harness();
    const lease = fake.controller.quiesceAndProve();

    expect(fake.stopExactOwner).toHaveBeenCalledOnce();
    expect(fake.writes.map((entry) => entry.phase)).toEqual(["acquiring", "stopped"]);
    expect(fake.ownerStopped()).toBe(true);
    expect(fake.watchers()).toEqual([]);
    expect(fake.durable()).toEqual(record("stopped"));
    lease.assertStillStopped();

    lease.resumeAndProve();
    expect(fake.resumeSameOwner).toHaveBeenCalledOnce();
    expect(fake.watchers()).toEqual([RESUMED]);
    expect(fake.durable()).toBeNull();
    expect(fake.store.clear).toHaveBeenCalledWith(LEASE_ID);
  });

  it("retains durable authority while observation runs and requiesces before finalization", () => {
    const fake = harness();
    const lease = fake.controller.quiesceAndProve();

    lease.resumeForObservationAndProve();
    expect(fake.watchers()).toEqual([RESUMED]);
    expect(fake.durable()).toEqual(expect.objectContaining({ ...RESUMED, phase: "observing" }));
    lease.assertStillHeld();

    lease.requiesceAndProve();
    expect(fake.watchers()).toEqual([]);
    expect(fake.durable()).toEqual(expect.objectContaining({ ...RESUMED, phase: "stopped" }));
    lease.assertStillStopped();

    lease.resumeAndProve();
    expect(fake.resumeSameOwner).toHaveBeenCalledTimes(2);
    expect(fake.stopExactOwner).toHaveBeenCalledTimes(2);
    expect(fake.durable()).toBeNull();
  });

  it("suspends and resumes one exact standalone watcher without replacing its process", () => {
    const fake = harness({}, { initial: STANDALONE_ORIGINAL, retainQuiescedProcess: true });
    const lease = fake.controller.quiesceAndProve();

    expect(fake.watchers()).toEqual([STANDALONE_ORIGINAL]);
    expect(fake.alive).toContain("4100:proc-start-100");
    expect(fake.healthy).not.toContain("4100:proc-start-100");
    lease.assertStillStopped();

    lease.resumeForObservationAndProve();
    expect(fake.watchers()).toEqual([STANDALONE_ORIGINAL]);
    expect(fake.healthy).toContain("4100:proc-start-100");

    lease.requiesceAndProve();
    lease.resumeAndProve();
    expect(fake.stopExactOwner).toHaveBeenCalledTimes(2);
    expect(fake.resumeSameOwner).toHaveBeenCalledTimes(2);
    expect(fake.watchers()).toEqual([STANDALONE_ORIGINAL]);
    expect(fake.durable()).toBeNull();
  });

  it("clears an acquiring record when the crash preceded the stop request", () => {
    const fake = harness();
    fake.setDurable(record("acquiring"));
    fake.setHolderAlive(false);

    fake.controller.recoverUnfinishedLease();

    expect(fake.resumeSameOwner).not.toHaveBeenCalled();
    expect(fake.stopExactOwner).not.toHaveBeenCalled();
    expect(fake.durable()).toBeNull();
  });

  it("resumes the exact owner when a crash followed stop but preceded the phase write", () => {
    const fake = harness();
    fake.setDurable(record("acquiring"));
    fake.setHolderAlive(false);
    fake.stopExactOwner();

    fake.controller.recoverUnfinishedLease();

    expect(fake.resumeSameOwner).toHaveBeenCalledOnce();
    expect(fake.watchers()).toEqual([RESUMED]);
    expect(fake.durable()).toBeNull();
  });

  it("recognizes an exact healthy post-resume owner without spawning a duplicate", () => {
    const fake = harness();
    fake.setDurable(record("stopped"));
    fake.setHolderAlive(false);
    fake.stopExactOwner();
    fake.resumeSameOwner();
    fake.resumeSameOwner.mockClear();

    fake.controller.recoverUnfinishedLease();

    expect(fake.resumeSameOwner).not.toHaveBeenCalled();
    expect(fake.durable()).toBeNull();
  });

  it("leaves a stopped lease untouched while its exact holder is alive", () => {
    const fake = harness();
    fake.setDurable(record("stopped"));
    fake.stopExactOwner();

    expect(() => fake.controller.recoverUnfinishedLease()).toThrow(
      "still owned by a live transaction process",
    );
    expect(fake.resumeSameOwner).not.toHaveBeenCalled();
    expect(fake.store.clear).not.toHaveBeenCalled();
    expect(fake.durable()).toEqual(record("stopped"));
  });

  it("lets a fresh controller reclaim the exact crash-left stopped lease", () => {
    const fake = harness();
    fake.setDurable(record("stopped"));
    fake.setHolderAlive(false);
    fake.stopExactOwner();

    const freshController = createPodmanManagedGatewayWatcherController(fake.deps);
    const lease = freshController.reclaimStoppedLease(LEASE_ID);

    expect(fake.store.advance).toHaveBeenCalledWith(
      LEASE_ID,
      expect.objectContaining({ leaseId: LEASE_ID, phase: "stopped" }),
    );
    lease.assertStillStopped();
    lease.resumeAndProve();
    expect(fake.resumeSameOwner).toHaveBeenCalledOnce();
    expect(fake.durable()).toBeNull();
  });

  it("refuses ambiguous watcher ownership before persisting or stopping", () => {
    const fake = harness({
      listTargetWatchers: () => [
        ORIGINAL,
        { ...ORIGINAL, pid: 4_101, processStartIdentity: "proc-start-101" },
      ],
    });

    expect(() => fake.controller.quiesceAndProve()).toThrow("exactly one target-bound");
    expect(fake.store.acquire).not.toHaveBeenCalled();
    expect(fake.stopExactOwner).not.toHaveBeenCalled();
  });

  it("does not stop when atomic acquisition detects a competing lease", () => {
    const fake = harness();
    fake.store.acquire.mockImplementation(() => {
      fake.setDurable({ ...record(), leaseId: OTHER_LEASE_ID });
      throw new Error("lease already exists");
    });

    expect(() => fake.controller.quiesceAndProve()).toThrow("lease already exists");
    expect(fake.stopExactOwner).not.toHaveBeenCalled();
    expect(fake.durable()?.leaseId).toBe(OTHER_LEASE_ID);
  });

  it("restores the watcher when the stopped-phase durable write fails", () => {
    const fake = harness();
    fake.store.advance.mockImplementation(() => {
      throw new Error("fsync failed");
    });

    expect(() => fake.controller.quiesceAndProve()).toThrow(
      "Persisting the stopped Podman watcher lease failed",
    );
    expect(fake.resumeSameOwner).toHaveBeenCalledOnce();
    expect(fake.watchers()).toEqual([RESUMED]);
    expect(fake.durable()).toBeNull();
  });

  it("leaves recovery authority intact when an unexpected watcher blocks resume", () => {
    const fake = harness();
    fake.setDurable(record("stopped"));
    fake.setHolderAlive(false);
    fake.stopExactOwner();
    fake.setOwnerStopped(false);
    fake.setWatchers([
      {
        ...RESUMED,
        launchIdentity: "unknown-launch",
        ownerIdentity: "unknown-owner",
      },
    ]);
    fake.alive.add("4200:proc-start-200");
    fake.healthy.add("4200:proc-start-200");

    let failure: unknown;
    try {
      fake.controller.recoverUnfinishedLease();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PodmanGatewayWatcherLeaseError);
    expect((failure as PodmanGatewayWatcherLeaseError).recoveryRequired).toBe(true);
    expect(fake.durable()).toEqual(record("stopped"));
    expect(fake.resumeSameOwner).not.toHaveBeenCalled();
  });

  it("detects durable lease replacement while a lease object is live", () => {
    const fake = harness();
    const lease = fake.controller.quiesceAndProve();
    fake.setDurable({ ...record("stopped"), leaseId: OTHER_LEASE_ID });

    expect(() => lease.assertStillStopped()).toThrow("lease changed while it was held");
    expect(() => lease.resumeAndProve()).toThrow("lease changed before release");
    expect(fake.resumeSameOwner).not.toHaveBeenCalled();
  });

  it("rejects invalid persisted authority without attempting lifecycle mutation", () => {
    const fake = harness();
    fake.setDurable({ ...record(), leaseId: "not-a-lease" });

    expect(() => fake.controller.recoverUnfinishedLease()).toThrow("lease is invalid");
    expect(fake.stopExactOwner).not.toHaveBeenCalled();
    expect(fake.resumeSameOwner).not.toHaveBeenCalled();
    expect(fake.store.clear).not.toHaveBeenCalled();
  });
});
