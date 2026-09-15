// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { LockObservation, McpLifecycleLockOwner } from "../mcp-lifecycle-lock-identity";
import { decideMcpLifecycleAcquisition, decideMcpLifecycleLock } from "./decisions";

const corruptGeneration = { generation: null, firstSeenAt: 0 };

function owner(): McpLifecycleLockOwner {
  return {
    version: 1,
    sandboxName: "alpha",
    pid: 123,
    processIdentity: "process",
    token: "owner-token",
    acquiredAt: "2026-08-31T00:00:00.000Z",
  };
}

function observation(lockOwner: McpLifecycleLockOwner | null): LockObservation {
  return { owner: lockOwner, mtimeMs: 10, dev: 1, ino: 2, reclaimable: true };
}

describe("sandbox mutation lock decisions", () => {
  it("reaps a stale owner", () => {
    expect(
      decideMcpLifecycleLock({
        observation: observation(owner()),
        sandboxName: "alpha",
        corruptLockGraceMs: 30,
        monotonicNow: 100,
        corruptGeneration,
        ownerDisposition: "stale",
      }).kind,
    ).toBe("reap");
  });

  it("ages one corrupt generation before reclaiming it", () => {
    const first = decideMcpLifecycleLock({
      observation: observation(null),
      sandboxName: "alpha",
      corruptLockGraceMs: 30,
      monotonicNow: 100,
      corruptGeneration,
    });
    expect(first.kind).toBe("wait");
    const aged = decideMcpLifecycleLock({
      observation: observation(null),
      sandboxName: "alpha",
      corruptLockGraceMs: 30,
      monotonicNow: 131,
      corruptGeneration: first.corruptGeneration,
    });
    expect(aged.kind).toBe("reap");
  });

  it("enters only when publication remains the sole active generation", () => {
    expect(
      decideMcpLifecycleAcquisition({
        phase: "published",
        reaperPresent: false,
        expectedOwnerToken: "owner-token",
        observedOwnerToken: "owner-token",
      }),
    ).toEqual({ kind: "enter" });
    expect(
      decideMcpLifecycleAcquisition({
        phase: "published",
        reaperPresent: true,
        expectedOwnerToken: "owner-token",
        observedOwnerToken: "owner-token",
      }),
    ).toEqual({ kind: "release" });
  });
});
