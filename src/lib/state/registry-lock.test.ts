// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { classifyExistingLock } from "./registry";

const STALE = 10_000;
const LOCK_MTIME = 1_000_000;

describe("registry lock staleness (PID-recycle wedge)", () => {
  it("breaks a lock whose owner process is dead", () => {
    expect(
      classifyExistingLock({
        ownerPid: 4242,
        ownerAlive: false,
        processStartMs: null,
        lockMtimeMs: LOCK_MTIME,
        nowMs: LOCK_MTIME + 50,
        staleMs: STALE,
      }),
    ).toBe("break");
  });

  it("breaks a lock held by a RECYCLED pid that started after the lock (self-found wedge)", () => {
    // kill(pid,0) succeeds, but the live process started after the lock was
    // taken -> the original holder crashed and the pid was reused. A
    // liveness-only check would wedge here forever.
    expect(
      classifyExistingLock({
        ownerPid: 4242,
        ownerAlive: true,
        processStartMs: LOCK_MTIME + 5_000,
        lockMtimeMs: LOCK_MTIME,
        nowMs: LOCK_MTIME + 5_100,
        staleMs: STALE,
      }),
    ).toBe("break");
  });

  it("waits on a live original holder with a fresh lock", () => {
    expect(
      classifyExistingLock({
        ownerPid: 4242,
        ownerAlive: true,
        processStartMs: LOCK_MTIME - 2_000,
        lockMtimeMs: LOCK_MTIME,
        nowMs: LOCK_MTIME + 200,
        staleMs: STALE,
      }),
    ).toBe("wait");
  });

  it("breaks a live original holder once the lock is clearly stale (wedged holder)", () => {
    expect(
      classifyExistingLock({
        ownerPid: 4242,
        ownerAlive: true,
        processStartMs: LOCK_MTIME - 2_000,
        lockMtimeMs: LOCK_MTIME,
        nowMs: LOCK_MTIME + STALE + 1,
        staleMs: STALE,
      }),
    ).toBe("break");
  });

  it("falls back to age when the owner pid is unreadable", () => {
    expect(
      classifyExistingLock({
        ownerPid: null,
        ownerAlive: false,
        processStartMs: null,
        lockMtimeMs: LOCK_MTIME,
        nowMs: LOCK_MTIME + 200,
        staleMs: STALE,
      }),
    ).toBe("wait");
    expect(
      classifyExistingLock({
        ownerPid: null,
        ownerAlive: false,
        processStartMs: null,
        lockMtimeMs: LOCK_MTIME,
        nowMs: LOCK_MTIME + STALE + 1,
        staleMs: STALE,
      }),
    ).toBe("break");
  });

  it("falls back to age when start time is unavailable (non-/proc host)", () => {
    // alive, but processStartMs null (no /proc): fresh -> wait, stale -> break.
    expect(
      classifyExistingLock({
        ownerPid: 4242,
        ownerAlive: true,
        processStartMs: null,
        lockMtimeMs: LOCK_MTIME,
        nowMs: LOCK_MTIME + 200,
        staleMs: STALE,
      }),
    ).toBe("wait");
    expect(
      classifyExistingLock({
        ownerPid: 4242,
        ownerAlive: true,
        processStartMs: null,
        lockMtimeMs: LOCK_MTIME,
        nowMs: LOCK_MTIME + STALE + 1,
        staleMs: STALE,
      }),
    ).toBe("break");
  });
});
