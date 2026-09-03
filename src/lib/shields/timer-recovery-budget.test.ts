// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginCommittedMcpLifecycleContainmentSync,
  getMcpLifecycleLockPath,
  withMcpLifecycleLock,
} from "../state/mcp-lifecycle-lock";

const shieldsIndexMock = vi.hoisted(() => ({
  applyShieldsPolicySnapshot: vi.fn((): { status: number } => ({ status: 0 })),
  completeAutoRestoreTransition: vi.fn(() => true),
  lockAgentConfig: vi.fn(),
  prepareAutoRestoreTransitionTakeover: vi.fn(),
  resolvePersistedAutoRestoreTarget: vi.fn(),
}));

vi.mock("./index", () => shieldsIndexMock);

const PROCESS_TOKEN = "a".repeat(32);

describe("detached Shields recovery budget", { timeout: 15_000 }, () => {
  let tmpHome: string;
  let stateDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "shields-recovery-budget-"));
    stateDir = path.join(tmpHome, ".nemoclaw", "state");
    vi.stubEnv("HOME", tmpHome);
    shieldsIndexMock.applyShieldsPolicySnapshot.mockImplementation(() => ({ status: 0 }));
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function createFixture(sandboxName: string) {
    const timer = await import("./timer");
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date().toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
      }),
    );
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "",
      "",
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();
    const lockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
    return { args: args!, lockPath, markerPath, sandboxName, timer };
  }

  function readAuditEntries(): Array<{ action: string; error?: string; warning?: string }> {
    return fs
      .readFileSync(path.join(stateDir, "shields-audit.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  it("shares seven attempts across pre-fence retries and then stops scheduling", async () => {
    const { args, lockPath, sandboxName, timer } = await createFixture("pre-fence-budget");
    fs.writeFileSync(path.dirname(lockPath), "blocks the lifecycle lock directory");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    await timer.runRestoreTimer(args, { retryDelayMs: 0, maxRestoreAttempts: 7 });
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1), {
      interval: 1,
      timeout: 10_000,
    });

    const auditsAtExit = readAuditEntries();
    expect(auditsAtExit).toHaveLength(7);
    expect(
      auditsAtExit.filter((entry) => entry.error?.includes("recovery failed after 7 attempts")),
    ).toHaveLength(1);
    expect(auditsAtExit.at(-1)?.error).toContain("recovery failed after 7 attempts");
    expect(auditsAtExit.at(-1)?.error).toContain("Correct the state-directory write failure");
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
    await expect(
      withMcpLifecycleLock(sandboxName, () => undefined, { stateDir }),
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(readAuditEntries()).toHaveLength(7);
  });

  it("shares the budget across scheduled setup failures and restoration", async () => {
    const { args, lockPath, timer } = await createFixture("cross-phase-budget");
    const containmentPath = `${lockPath}.containment`;
    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    const setupError = new Error("simulated pre-fence setup failure") as NodeJS.ErrnoException;
    setupError.code = "EIO";
    const rejectSetup = async (): Promise<never> => {
      throw setupError;
    };
    vi.spyOn(fs.promises, "mkdir")
      .mockImplementationOnce(rejectSetup)
      .mockImplementationOnce(rejectSetup)
      .mockImplementation(originalMkdir);
    shieldsIndexMock.applyShieldsPolicySnapshot.mockReturnValue({ status: 1 });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    await timer.runRestoreTimer(args, { retryDelayMs: 0, maxRestoreAttempts: 7 });
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1), {
      interval: 1,
      timeout: 10_000,
    });

    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(5);
    expect(fs.existsSync(containmentPath)).toBe(true);
    expect(
      readAuditEntries().filter((entry) =>
        entry.error?.includes("recovery failed after 7 attempts"),
      ),
    ).toHaveLength(1);
  });

  it("waits beyond the recovery budget for a verified live lifecycle owner, then restores", async () => {
    const sandboxName = "healthy-owner";
    let markOwnerEntered!: () => void;
    let releaseOwner!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      markOwnerEntered = resolve;
    });
    const ownerReleased = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = withMcpLifecycleLock(
      sandboxName,
      async () => {
        markOwnerEntered();
        await ownerReleased;
      },
      { stateDir, pollIntervalMs: 1, timeoutMs: 1_000 },
    );
    await ownerEntered;

    const { args, lockPath, timer } = await createFixture(sandboxName);
    const containmentPath = `${lockPath}.containment`;
    const deadlinePath = `${lockPath}.deadline`;
    shieldsIndexMock.applyShieldsPolicySnapshot.mockReturnValue({ status: 0 });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    try {
      const restore = timer.runRestoreTimer(args, {
        deadlineSetupTimeoutMs: 10,
        maxRestoreAttempts: 1,
        retryDelayMs: 0,
      });
      await vi.waitFor(() => expect(fs.existsSync(deadlinePath)).toBe(true), {
        interval: 1,
        timeout: 10_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(exitSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(containmentPath)).toBe(false);
      expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
      const waitingAudits = readAuditEntries();
      expect(waitingAudits).toEqual([
        expect.objectContaining({
          action: "shields_auto_restore_lock_warning",
          warning: expect.stringContaining("verified live sandbox mutation owner"),
        }),
      ]);
      expect(JSON.stringify(waitingAudits)).not.toContain("Contained owner PID");
      expect(waitingAudits).not.toContainEqual(
        expect.objectContaining({ action: "shields_up_failed" }),
      );

      releaseOwner();
      await Promise.all([owner, restore]);

      expect(exitSpy).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledOnce();
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(deadlinePath)).toBe(false);
      expect(fs.existsSync(containmentPath)).toBe(false);
      expect(readAuditEntries()).not.toContainEqual(
        expect.objectContaining({ action: "shields_up_failed" }),
      );
    } finally {
      releaseOwner();
      await owner;
    }
  });

  it("charges deadline-main publication failures to the same bounded budget", async () => {
    const { args, lockPath, sandboxName, timer } = await createFixture("publication-budget");
    const containmentPath = `${lockPath}.containment`;
    const deadlinePath = `${lockPath}.deadline`;
    const originalLink = fs.promises.link.bind(fs.promises);
    const publicationError = new Error(
      "simulated deadline-main publication failure",
    ) as NodeJS.ErrnoException;
    publicationError.code = "EROFS";
    const linkSpy = vi
      .spyOn(fs.promises, "link")
      .mockImplementationOnce(originalLink)
      .mockRejectedValue(publicationError);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    await timer.runRestoreTimer(args, { retryDelayMs: 0, maxRestoreAttempts: 3 });

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(linkSpy).toHaveBeenCalledTimes(4);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
    expect(fs.existsSync(deadlinePath)).toBe(false);
    expect(fs.existsSync(containmentPath)).toBe(true);
    expect(readAuditEntries()).toHaveLength(2);
    expect(readAuditEntries().at(-1)?.error).toContain("recovery failed after 3 attempts");
    await expect(withMcpLifecycleLock(sandboxName, () => undefined, { stateDir })).rejects.toThrow(
      "Sandbox mutation containment is active",
    );
  });

  it("retains its exact deadline when publication and containment both fail", async () => {
    const { args, lockPath, markerPath, sandboxName, timer } = await createFixture("publish-gate");
    const containmentPath = `${lockPath}.containment`;
    const deadlinePath = `${lockPath}.deadline`;
    const originalAsyncLink = fs.promises.link.bind(fs.promises);
    const publicationError = new Error(
      "simulated deadline-main publication failure",
    ) as NodeJS.ErrnoException;
    publicationError.code = "EROFS";
    vi.spyOn(fs.promises, "link")
      .mockImplementationOnce(originalAsyncLink)
      .mockRejectedValue(publicationError);
    vi.spyOn(fs, "linkSync").mockImplementation((_existingPath, newPath) => {
      expect(String(newPath)).toBe(containmentPath);
      const error = new Error("simulated containment publication failure") as NodeJS.ErrnoException;
      error.code = "EROFS";
      throw error;
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    let contenderEntered = false;

    await timer.runRestoreTimer(args, { retryDelayMs: 0, maxRestoreAttempts: 1 });

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(containmentPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(deadlinePath, "utf-8"))).toMatchObject({
      sandboxName,
      shieldsTakeoverToken: PROCESS_TOKEN,
    });
    const audits = readAuditEntries();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.error).toContain("recovery failed after 1 attempt");
    expect(audits[0]?.error).toContain("Correct the state-directory write failure");
    expect(audits[0]?.error).toContain("`nemoclaw publish-gate shields status`");
    expect(audits[0]?.error).not.toContain("setup is retrying");
    await expect(
      withMcpLifecycleLock(
        sandboxName,
        () => {
          contenderEntered = true;
        },
        { stateDir, pollIntervalMs: 1, timeoutMs: 10 },
      ),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    expect(contenderEntered).toBe(false);
  });

  it("exits immediately when durable containment already owns recovery", async () => {
    const { args, lockPath, sandboxName, timer } = await createFixture("existing-contain");
    beginCommittedMcpLifecycleContainmentSync(
      sandboxName,
      PROCESS_TOKEN,
      "existing exact-generation containment",
      stateDir,
    );
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    await timer.runRestoreTimer(args, { retryDelayMs: 0, maxRestoreAttempts: 7 });

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
    const audits = readAuditEntries();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.error).toContain("committed process-tree containment");
  });
});
