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
  applyShieldsPolicySnapshot: vi.fn(() => ({ status: 0 })),
  completeAutoRestoreTransition: vi.fn(() => true),
  lockAgentConfig: vi.fn(),
  prepareAutoRestoreTransitionTakeover: vi.fn(),
  resolvePersistedAutoRestoreTarget: vi.fn(),
}));

vi.mock("./index", () => shieldsIndexMock);

const PROCESS_TOKEN = "a".repeat(32);

describe("detached Shields recovery budget", () => {
  let tmpHome: string;
  let stateDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "shields-recovery-budget-"));
    stateDir = path.join(tmpHome, ".nemoclaw", "state");
    vi.stubEnv("HOME", tmpHome);
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

  function readAuditEntries(): Array<{ error?: string }> {
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
      timeout: 2_000,
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
    const lifecycleDirectory = path.dirname(lockPath);
    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    let setupFailuresRemaining = 2;
    vi.spyOn(fs.promises, "mkdir").mockImplementation(async (targetPath, options) => {
      if (String(targetPath) === lifecycleDirectory && setupFailuresRemaining > 0) {
        setupFailuresRemaining -= 1;
        const error = new Error("simulated pre-fence setup failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return await originalMkdir(targetPath, options);
    });
    shieldsIndexMock.applyShieldsPolicySnapshot.mockReturnValue({ status: 1 });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    await timer.runRestoreTimer(args, { retryDelayMs: 0, maxRestoreAttempts: 7 });
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1), {
      interval: 1,
      timeout: 2_000,
    });

    expect(setupFailuresRemaining).toBe(0);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(5);
    expect(fs.existsSync(containmentPath)).toBe(true);
    expect(
      readAuditEntries().filter((entry) =>
        entry.error?.includes("recovery failed after 7 attempts"),
      ),
    ).toHaveLength(1);
  });

  it("charges deadline-main publication failures to the same bounded budget", async () => {
    const { args, lockPath, sandboxName, timer } = await createFixture("publication-budget");
    const containmentPath = `${lockPath}.containment`;
    const deadlinePath = `${lockPath}.deadline`;
    const originalLink = fs.promises.link.bind(fs.promises);
    let mainPublicationAttempts = 0;
    vi.spyOn(fs.promises, "link").mockImplementation(async (existingPath, newPath) => {
      if (String(newPath) === lockPath) {
        mainPublicationAttempts += 1;
        const error = new Error(
          "simulated deadline-main publication failure",
        ) as NodeJS.ErrnoException;
        error.code = "EROFS";
        throw error;
      }
      return await originalLink(existingPath, newPath);
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    await timer.runRestoreTimer(args, { retryDelayMs: 0, maxRestoreAttempts: 3 });

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mainPublicationAttempts).toBe(3);
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
    const { args, lockPath, markerPath, sandboxName, timer } = await createFixture(
      "publication-retained-gate",
    );
    const containmentPath = `${lockPath}.containment`;
    const deadlinePath = `${lockPath}.deadline`;
    const originalAsyncLink = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, "link").mockImplementation(async (existingPath, newPath) => {
      if (String(newPath) === lockPath) {
        const error = new Error(
          "simulated deadline-main publication failure",
        ) as NodeJS.ErrnoException;
        error.code = "EROFS";
        throw error;
      }
      return await originalAsyncLink(existingPath, newPath);
    });
    const originalSyncLink = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync").mockImplementation((existingPath, newPath) => {
      if (String(newPath) === containmentPath) {
        const error = new Error(
          "simulated containment publication failure",
        ) as NodeJS.ErrnoException;
        error.code = "EROFS";
        throw error;
      }
      return originalSyncLink(existingPath, newPath);
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
    const { args, lockPath, sandboxName, timer } = await createFixture("existing-containment");
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
