// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginCommittedMcpLifecycleContainmentSync,
  withMcpLifecycleDeadlineFenceSync,
  withMcpLifecycleLock,
} from "./mcp-lifecycle-lock-acquisition";
import {
  createMcpLifecycleLockOwner,
  readMcpLockHostIdentity,
  readMcpLockPidNamespaceIdentity,
} from "./mcp-lifecycle-lock-identity";
import { getMcpLifecycleLockPath } from "./mcp-lifecycle-lock-storage";

const SANDBOX_NAME = "issue-10635-test";
const DEAD_MAIN_PID = 2_147_483_647;
const DEAD_TIMER_PID = 2_147_483_645;
let stateDir: string;

function options() {
  return {
    stateDir,
    pollIntervalMs: 1,
    timeoutMs: 1_000,
    corruptLockGraceMs: 1,
  };
}

function writeExpiredTimerMarker(processToken: string): void {
  fs.writeFileSync(
    path.join(stateDir, `shields-timer-${SANDBOX_NAME}.json`),
    JSON.stringify({
      pid: DEAD_TIMER_PID,
      sandboxName: SANDBOX_NAME,
      snapshotPath: path.join(stateDir, "snapshot.yaml"),
      restoreAt: new Date(Date.now() - 1_000).toISOString(),
      processToken,
    }),
  );
}

function writeStructuredTimerBoundContainment(
  processToken: string,
  containedOwnerPid = DEAD_MAIN_PID,
): { containmentPath: string; lockPath: string } {
  const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      version: 1,
      sandboxName: SANDBOX_NAME,
      pid: DEAD_MAIN_PID,
      processIdentity: "dead-main-owner",
      hostIdentity: readMcpLockHostIdentity(),
      pidNamespaceIdentity: readMcpLockPidNamespaceIdentity(),
      shieldsTakeoverToken: processToken,
      token: "stale-main-token",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
  const mainStat = fs.statSync(lockPath);
  const containmentPath = `${lockPath}.containment`;
  fs.writeFileSync(
    containmentPath,
    JSON.stringify({
      ...createMcpLifecycleLockOwner(SANDBOX_NAME, "containment-token", processToken),
      pid: 2_147_483_646,
      processIdentity: "dead-containment-owner",
      containmentReason: "Timer-bound mutation containment",
      containedGeneration: {
        target: "main",
        dev: mainStat.dev,
        ino: mainStat.ino,
        token: "stale-main-token",
        ownerPid: containedOwnerPid,
      },
    }),
  );
  return { containmentPath, lockPath };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-containment-recovery-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("timer-bound mutation containment recovery (#10635)", () => {
  it("recovers a stale mutation owner after its distinct timer owner completes", () => {
    const processToken = "a".repeat(32);
    const paths = writeStructuredTimerBoundContainment(processToken);

    expect(
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, () => "complete", {
        ...options(),
        completedAutoRestoreRecovery: {
          ownerPid: DEAD_TIMER_PID,
          assertAuthority: vi.fn(),
        },
      }),
    ).toBe("complete");
    expect(fs.existsSync(paths.lockPath)).toBe(false);
    expect(fs.existsSync(paths.containmentPath)).toBe(false);
  });

  it("does not recover a different stale main owner without structured containment", () => {
    const processToken = "b".repeat(32);
    const paths = writeStructuredTimerBoundContainment(processToken);
    fs.unlinkSync(paths.containmentPath);
    const operation = vi.fn();

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, {
        ...options(),
        completedAutoRestoreRecovery: {
          ownerPid: DEAD_TIMER_PID,
          assertAuthority: vi.fn(),
        },
      }),
    ).toThrow("main generation is not an exact stale timer-bound owner");
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.lockPath)).toBe(true);
  });

  it("preserves containment when its owner does not match the protected main generation", () => {
    const processToken = "b".repeat(32);
    const paths = writeStructuredTimerBoundContainment(processToken, 2_147_483_644);
    const operation = vi.fn();

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, {
        ...options(),
        completedAutoRestoreRecovery: {
          ownerPid: DEAD_TIMER_PID,
          assertAuthority: vi.fn(),
        },
      }),
    ).toThrow("main generation is not an exact stale timer-bound owner");
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.lockPath)).toBe(true);
    expect(fs.existsSync(paths.containmentPath)).toBe(true);
  });

  it("reports the bounded wait before recovering an abandoned timer", async () => {
    const onAbandonedTimerRecoveryWait = vi.fn();
    writeExpiredTimerMarker("c".repeat(32));

    await expect(
      withMcpLifecycleLock(SANDBOX_NAME, () => "entered", {
        ...options(),
        recoverAbandonedExpiredTimer: true,
        onAbandonedTimerRecoveryWait,
      }),
    ).resolves.toBe("entered");
    expect(onAbandonedTimerRecoveryWait).toHaveBeenCalledOnce();
    expect(onAbandonedTimerRecoveryWait).toHaveBeenCalledWith({ timeoutMs: 1_000 });
  });

  it("refuses committed containment before the abandoned-timer grace wait", async () => {
    const processToken = "d".repeat(32);
    const onAbandonedTimerRecoveryWait = vi.fn();
    beginCommittedMcpLifecycleContainmentSync(
      SANDBOX_NAME,
      processToken,
      "test committed containment",
      stateDir,
    );

    await expect(
      withMcpLifecycleLock(SANDBOX_NAME, () => "must not enter", {
        ...options(),
        recoverAbandonedExpiredTimer: true,
        onAbandonedTimerRecoveryWait,
      }),
    ).rejects.toThrow("Sandbox mutation containment is active");
    expect(onAbandonedTimerRecoveryWait).not.toHaveBeenCalled();
  });
});
