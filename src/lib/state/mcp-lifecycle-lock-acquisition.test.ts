// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginCommittedMcpLifecycleContainmentSync,
  isMcpLifecycleLockHeld,
  withMcpLifecycleDeadlineFence,
  withMcpLifecycleDeadlineFenceSync,
  withMcpLifecycleLockSync,
} from "./mcp-lifecycle-lock-acquisition";
import { createMcpLifecycleLockOwner } from "./mcp-lifecycle-lock-identity";
import { getMcpLifecycleLockPath } from "./mcp-lifecycle-lock-storage";

const SANDBOX_NAME = "alpha";
let stateDir: string;

function options() {
  return {
    stateDir,
    pollIntervalMs: 1,
    timeoutMs: 20,
    corruptLockGraceMs: 1,
  };
}

function writeTimerMarker(processToken: string): void {
  fs.writeFileSync(
    path.join(stateDir, `shields-timer-${SANDBOX_NAME}.json`),
    JSON.stringify({
      pid: process.pid,
      sandboxName: SANDBOX_NAME,
      snapshotPath: path.join(stateDir, "snapshot.yaml"),
      restoreAt: new Date(Date.now() + 60_000).toISOString(),
      processToken,
    }),
  );
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-acquisition-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("MCP lifecycle lock acquisition", () => {
  it("releases a synchronous lock after nested work completes", () => {
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const events: string[] = [];

    const result = withMcpLifecycleLockSync(
      SANDBOX_NAME,
      () => {
        expect(isMcpLifecycleLockHeld(SANDBOX_NAME, stateDir)).toBe(true);
        events.push("outer");
        return withMcpLifecycleLockSync(
          SANDBOX_NAME,
          () => {
            expect(isMcpLifecycleLockHeld(SANDBOX_NAME, stateDir)).toBe(true);
            events.push("nested");
            return "complete";
          },
          options(),
        );
      },
      options(),
    );

    expect(result).toBe("complete");
    expect(events).toEqual(["outer", "nested"]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("allows a nested synchronous lock during deadline recovery and releases the main lock and deadline gate afterward", () => {
    const processToken = "a".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker(processToken);

    const result = withMcpLifecycleDeadlineFenceSync(
      SANDBOX_NAME,
      processToken,
      () => {
        expect(isMcpLifecycleLockHeld(SANDBOX_NAME, stateDir)).toBe(true);
        return withMcpLifecycleLockSync(SANDBOX_NAME, () => "restored", options());
      },
      options(),
    );

    expect(result).toBe("restored");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.deadline`)).toBe(false);
  });

  it("blocks synchronous mutation while committed containment is active", () => {
    const processToken = "b".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker(processToken);
    beginCommittedMcpLifecycleContainmentSync(
      SANDBOX_NAME,
      processToken,
      "test containment",
      stateDir,
    );

    expect(() => withMcpLifecycleLockSync(SANDBOX_NAME, () => "entered", options())).toThrow(
      "Sandbox mutation containment is active",
    );
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
  });

  it("keeps an active deadline gate closed when containment reporting fails", async () => {
    const processToken = "c".repeat(32);
    const replacementToken = "d".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    writeTimerMarker(processToken);
    fs.mkdirSync(path.dirname(deadlinePath), { recursive: true });
    fs.writeFileSync(
      deadlinePath,
      `${JSON.stringify(
        createMcpLifecycleLockOwner(SANDBOX_NAME, "active-deadline-owner", processToken),
      )}\n`,
    );
    const onContainment = vi.fn(() => {
      writeTimerMarker(replacementToken);
      throw new Error("audit unavailable");
    });

    await expect(
      withMcpLifecycleDeadlineFence(SANDBOX_NAME, processToken, () => "entered", {
        ...options(),
        onContainment,
      }),
    ).rejects.toThrow("Auto-restore authority changed");
    expect(onContainment).toHaveBeenCalledOnce();
    expect(fs.existsSync(deadlinePath)).toBe(true);
  });
});
