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
const RESUMED = Object.freeze({
  ...ORIGINAL,
  pid: 4_200,
  processStartIdentity: "proc-start-200",
});

function record(
  phase: PodmanGatewayWatcherLeaseRecord["phase"] = "acquiring",
): PodmanGatewayWatcherLeaseRecord {
  return Object.freeze({
    ...ORIGINAL,
    schemaVersion: PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
    leaseId: LEASE_ID,
    phase,
  });
}

function harness(overrides: Partial<PodmanManagedGatewayWatcherControllerDeps> = {}) {
  let durable: PodmanGatewayWatcherLeaseRecord | null = null;
  let ownerStopped = false;
  let watchers: PodmanGatewayWatcherSnapshot[] = [ORIGINAL];
  const alive = new Set(["4100:proc-start-100"]);
  const healthy = new Set(["4100:proc-start-100"]);
  const key = (entry: PodmanGatewayWatcherSnapshot) =>
    `${String(entry.pid)}:${entry.processStartIdentity}`;
  const writes: PodmanGatewayWatcherLeaseRecord[] = [];
  const store = {
    read: vi.fn(() => durable),
    write: vi.fn((value: PodmanGatewayWatcherLeaseRecord) => {
      durable = value;
      writes.push(value);
    }),
    clear: vi.fn((expectedLeaseId: string) => {
      if (durable?.leaseId !== expectedLeaseId) throw new Error("lease compare-and-clear failed");
      durable = null;
    }),
  };
  const stopExactOwner = vi.fn(() => {
    alive.delete(key(ORIGINAL));
    healthy.delete(key(ORIGINAL));
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
    store,
    captureCurrent: () => ORIGINAL,
    listTargetWatchers: () => watchers,
    isProcessInstanceAlive: (entry) => alive.has(key(entry)),
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
    durable: () => durable,
    healthy,
    ownerStopped: () => ownerStopped,
    resumeSameOwner,
    setDurable: (value: PodmanGatewayWatcherLeaseRecord | null) => {
      durable = value;
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

  it("clears an acquiring record when the crash preceded the stop request", () => {
    const fake = harness();
    fake.setDurable(record("acquiring"));

    fake.controller.recoverUnfinishedLease();

    expect(fake.resumeSameOwner).not.toHaveBeenCalled();
    expect(fake.stopExactOwner).not.toHaveBeenCalled();
    expect(fake.durable()).toBeNull();
  });

  it("resumes the exact owner when a crash followed stop but preceded the phase write", () => {
    const fake = harness();
    fake.setDurable(record("acquiring"));
    fake.stopExactOwner();

    fake.controller.recoverUnfinishedLease();

    expect(fake.resumeSameOwner).toHaveBeenCalledOnce();
    expect(fake.watchers()).toEqual([RESUMED]);
    expect(fake.durable()).toBeNull();
  });

  it("recognizes an exact healthy post-resume owner without spawning a duplicate", () => {
    const fake = harness();
    fake.setDurable(record("stopped"));
    fake.stopExactOwner();
    fake.resumeSameOwner();
    fake.resumeSameOwner.mockClear();

    fake.controller.recoverUnfinishedLease();

    expect(fake.resumeSameOwner).not.toHaveBeenCalled();
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
    expect(fake.store.write).not.toHaveBeenCalled();
    expect(fake.stopExactOwner).not.toHaveBeenCalled();
  });

  it("restores the watcher when the stopped-phase durable write fails", () => {
    const fake = harness();
    fake.store.write.mockImplementation((value: PodmanGatewayWatcherLeaseRecord) => {
      if (value.phase === "stopped") throw new Error("fsync failed");
      fake.setDurable(value);
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
