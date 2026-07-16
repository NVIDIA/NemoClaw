// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ShieldsTransitionLockManager,
  type ShieldsTransitionLockOwner,
  shieldsTransitionLockPath,
} from "./transition-lock";

const SELF_PID = 101;
const SELF_IDENTITY = "proc:self-start";
const TAKEOVER_TOKEN = "a".repeat(32);
const OTHER_TAKEOVER_TOKEN = "b".repeat(32);

function runWhen(condition: boolean, action: () => void): void {
  condition && action();
}

function readLockFileSnapshot(lockPath: string) {
  const fd = fs.openSync(
    lockPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    expect(stat.isFile(), `expected a regular lock file at '${lockPath}'`).toBe(true);
    return {
      contents: fs.readFileSync(fd, "utf8"),
      inode: stat.ino,
      mode: stat.mode & 0o777n,
      mtimeMs: Number(stat.mtimeMs),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function owner(
  sandboxName: string,
  pid: number,
  processStartIdentity: string,
  command = "nemoclaw sandbox shields up",
  takeoverToken?: string,
): ShieldsTransitionLockOwner {
  return {
    version: 1,
    sandboxName,
    pid,
    processStartIdentity,
    command,
    acquiredAtMs: 1_000,
    ...(takeoverToken ? { takeoverToken } : {}),
  };
}

describe("host shields transition lock", () => {
  let root: string;
  let stateDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-transition-lock-"));
    stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function manager(
    overrides: Partial<ConstructorParameters<typeof ShieldsTransitionLockManager>[0]> = {},
  ): ShieldsTransitionLockManager {
    return new ShieldsTransitionLockManager({
      stateDir,
      pid: SELF_PID,
      now: () => 2_000,
      sleep: () => {},
      isProcessAlive: (pid) => pid === SELF_PID,
      readProcessStartIdentity: (pid) => (pid === SELF_PID ? SELF_IDENTITY : null),
      ...overrides,
    });
  }

  function writeOwner(sandboxName: string, value: ShieldsTransitionLockOwner | string): string {
    const lockPath = shieldsTransitionLockPath(sandboxName, stateDir);
    fs.writeFileSync(lockPath, typeof value === "string" ? value : JSON.stringify(value), {
      mode: 0o600,
    });
    return lockPath;
  }

  function createRecoveryGuard(sandboxName: string): { lockPath: string; guardPath: string } {
    const lockPath = shieldsTransitionLockPath(sandboxName, stateDir);
    const guardPath = `${lockPath}.recovering`;
    return { lockPath, guardPath };
  }

  function writeRecoveryGuardOwner(guardPath: string, value: ShieldsTransitionLockOwner): void {
    fs.writeFileSync(guardPath, JSON.stringify(value), { mode: 0o600 });
  }

  it("atomically creates a regular owner file and removes it after the callback", () => {
    const locker = manager();
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);
    const originalLinkSync = fs.linkSync;
    let completeBeforePublish = false;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      expect(String(destination)).toBe(lockPath);
      expect(String(source)).not.toBe(lockPath);
      expect(JSON.parse(fs.readFileSync(source, "utf8"))).toMatchObject({
        sandboxName: "alpha",
        pid: SELF_PID,
        processStartIdentity: SELF_IDENTITY,
      });
      completeBeforePublish = true;
      originalLinkSync(source, destination);
    });

    const result = locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => {
      const snapshot = readLockFileSnapshot(lockPath);
      const written = JSON.parse(snapshot.contents);
      expect(process.platform === "win32" || snapshot.mode === 0o600n).toBe(true);
      expect(written).toEqual({
        version: 1,
        sandboxName: "alpha",
        pid: SELF_PID,
        processStartIdentity: SELF_IDENTITY,
        command: "nemoclaw alpha shields up",
        acquiredAtMs: 2_000,
      });
      return "complete";
    });

    expect(result).toBe("complete");
    expect(completeBeforePublish).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("uses a unique self identity when the current process start identity is unavailable", () => {
    const locker = manager({ readProcessStartIdentity: () => null });
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);

    locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => {
      const written = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      expect(written).toMatchObject({
        sandboxName: "alpha",
        pid: SELF_PID,
        command: "nemoclaw alpha shields up",
      });
      expect(written.processStartIdentity).toMatch(/^unverified-self:101:[0-9a-f]{32}$/u);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not reclaim a live owner with an unverified self identity", () => {
    const ownerLocker = manager({ readProcessStartIdentity: () => null });
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);
    let contenderNow = 2_000;
    const contender = manager({
      now: () => contenderNow,
      sleep: (milliseconds) => {
        contenderNow += milliseconds;
      },
      isProcessAlive: (pid) => pid === SELF_PID,
      readProcessStartIdentity: (pid) => (pid === SELF_PID ? SELF_IDENTITY : null),
    });

    ownerLocker.withShieldsTransitionLock("alpha", "owner with unverified identity", () => {
      expect(() =>
        contender.withShieldsTransitionLock("alpha", "contender", () => "unexpected", {
          waitTimeoutMs: 2,
          pollIntervalMs: 1,
        }),
      ).toThrow(/PID 101 is alive but its process-start identity cannot be verified/);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).command).toBe(
        "owner with unverified identity",
      );
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not asynchronously reclaim a live owner with an unverified self identity", async () => {
    const ownerLocker = manager({ readProcessStartIdentity: () => null });
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);
    let contenderNow = 2_000;
    const contender = manager({
      now: () => contenderNow,
      sleepAsync: async (milliseconds) => {
        contenderNow += milliseconds;
      },
      isProcessAlive: (pid) => pid === SELF_PID,
      readProcessStartIdentity: (pid) => (pid === SELF_PID ? SELF_IDENTITY : null),
    });

    await ownerLocker.withShieldsTransitionLockAsync(
      "alpha",
      "async owner with unverified identity",
      async () => {
        await expect(
          contender.withShieldsTransitionLockAsync(
            "alpha",
            "async contender",
            async () => {
              throw new Error("should not reclaim live unverified owner");
            },
            {
              waitTimeoutMs: 2,
              pollIntervalMs: 1,
            },
          ),
        ).rejects.toThrow(/PID 101 is alive but its process-start identity cannot be verified/);
        expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).command).toBe(
          "async owner with unverified identity",
        );
      },
    );

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("never publishes a canonical owner when atomic link publication fails", () => {
    const locker = manager();
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      const error = new Error("injected publication failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    });

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields down", () => undefined),
    ).toThrow(/injected publication failure/);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("defers process.exit until after the canonical lock is released", () => {
    const locker = manager();
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);
    const exitError = new Error("captured real exit");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      expect(code).toBe(7);
      expect(fs.existsSync(lockPath)).toBe(false);
      throw exitError;
    }) as never);

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "failing policy command", () => {
        process.exit(7);
      }),
    ).toThrow(exitError);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("persists an optional authorized takeover token", () => {
    const locker = manager();
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);

    locker.withShieldsTransitionLock(
      "alpha",
      "nemoclaw alpha shields down",
      () => {
        expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
          pid: SELF_PID,
          processStartIdentity: SELF_IDENTITY,
          takeoverToken: TAKEOVER_TOKEN,
        });
      },
      { takeoverToken: TAKEOVER_TOKEN },
    );
  });

  it("inspects owner identity only for the matching takeover token", () => {
    const locker = manager();
    writeOwner("alpha", owner("alpha", 202, "proc:holder", "shields down", TAKEOVER_TOKEN));

    expect(locker.inspectShieldsTransitionLockOwner("alpha", OTHER_TAKEOVER_TOKEN)).toBeNull();
    expect(locker.inspectShieldsTransitionLockOwner("alpha", TAKEOVER_TOKEN)).toEqual({
      pid: 202,
      processStartIdentity: "proc:holder",
      command: "shields down",
    });
  });

  it("returns no inspected owner when the canonical path changes identity before open", () => {
    const locker = manager();
    const original = owner("alpha", 202, "proc:original", "original", TAKEOVER_TOKEN);
    const replacement = owner("alpha", 303, "proc:replacement", "replacement", TAKEOVER_TOKEN);
    const lockPath = writeOwner("alpha", original);
    const displacedPath = `${lockPath}.displaced`;
    const originalOpenSync = fs.openSync;
    let swapped = false;
    vi.spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
      runWhen(String(file) === lockPath && !swapped, () => {
        swapped = true;
        fs.renameSync(lockPath, displacedPath);
        fs.writeFileSync(lockPath, JSON.stringify(replacement), { mode: 0o600 });
      });
      return originalOpenSync(file, flags, mode);
    }) as typeof fs.openSync);

    expect(locker.inspectShieldsTransitionLockOwner("alpha", TAKEOVER_TOKEN)).toBeNull();
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(replacement);
    expect(JSON.parse(fs.readFileSync(displacedPath, "utf8"))).toEqual(original);
  });

  it("rejects takeover with the wrong token without moving the owner", () => {
    const recorded = owner("alpha", 202, "proc:owner", "shields down", TAKEOVER_TOKEN);
    const lockPath = writeOwner("alpha", recorded);
    const result = manager().takeoverShieldsTransitionLock(
      "alpha",
      202,
      "proc:owner",
      OTHER_TAKEOVER_TOKEN,
    );

    expect(result).toEqual({ removed: false, reason: "owner-mismatch" });
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(recorded);
  });

  it("rejects takeover while the exact owner process is still live", () => {
    const recorded = owner("alpha", 202, "proc:owner", "shields down", TAKEOVER_TOKEN);
    const lockPath = writeOwner("alpha", recorded);
    const locker = manager({
      isProcessAlive: (pid) => pid === SELF_PID || pid === 202,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === 202 ? "proc:owner" : null,
    });

    expect(
      locker.takeoverShieldsTransitionLock("alpha", 202, "proc:owner", TAKEOVER_TOKEN),
    ).toEqual({ removed: false, reason: "owner-live" });
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(recorded);
  });

  it("rejects a mismatched expected identity even when the PID was reused", () => {
    const recorded = owner("alpha", 202, "proc:owner", "shields down", TAKEOVER_TOKEN);
    const lockPath = writeOwner("alpha", recorded);
    const locker = manager({
      isProcessAlive: (pid) => pid === SELF_PID || pid === 202,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === 202 ? "proc:reused" : null,
    });

    expect(
      locker.takeoverShieldsTransitionLock("alpha", 202, "proc:not-owner", TAKEOVER_TOKEN),
    ).toEqual({ removed: false, reason: "owner-mismatch" });
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(recorded);
  });

  it("removes the exact token-authorized lock after its owner dies", () => {
    const lockPath = writeOwner(
      "alpha",
      owner("alpha", 202, "proc:owner", "shields down", TAKEOVER_TOKEN),
    );

    expect(
      manager().takeoverShieldsTransitionLock("alpha", 202, "proc:owner", TAKEOVER_TOKEN),
    ).toEqual({ removed: true, reason: "removed-dead-owner" });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("removes the exact token-authorized lock after its PID is reused", () => {
    const lockPath = writeOwner(
      "alpha",
      owner("alpha", 202, "proc:owner", "shields down", TAKEOVER_TOKEN),
    );
    const locker = manager({
      isProcessAlive: (pid) => pid === SELF_PID || pid === 202,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === 202 ? "proc:reused" : null,
    });

    expect(
      locker.takeoverShieldsTransitionLock("alpha", 202, "proc:owner", TAKEOVER_TOKEN),
    ).toEqual({ removed: true, reason: "removed-reused-pid" });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("preserves a replacement raced into token-specific stale recovery", () => {
    const original = owner("alpha", 202, "proc:owner", "shields down", TAKEOVER_TOKEN);
    const replacement = owner(
      "alpha",
      303,
      "proc:replacement",
      "replacement owner",
      TAKEOVER_TOKEN,
    );
    const lockPath = writeOwner("alpha", original);
    const displacedPath = `${lockPath}.displaced`;
    const originalLinkSync = fs.linkSync;
    let raced = false;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      runWhen(String(source) === lockPath && !raced, () => {
        raced = true;
        fs.renameSync(lockPath, displacedPath);
        fs.writeFileSync(lockPath, JSON.stringify(replacement), { mode: 0o600 });
      });
      originalLinkSync(source, destination);
    });
    const locker = manager({
      isProcessAlive: (pid) => pid === SELF_PID || pid === 303,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === 303 ? "proc:replacement" : null,
    });

    const result = locker.takeoverShieldsTransitionLock("alpha", 202, "proc:owner", TAKEOVER_TOKEN);

    expect(result).toEqual({ removed: false, reason: "path-changed" });
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(replacement);
    expect(JSON.parse(fs.readFileSync(displacedPath, "utf8"))).toEqual(original);
  });

  it("waits for a live holder with the same process identity", () => {
    const holderPid = 202;
    const holderIdentity = "proc:holder-start";
    const lockPath = writeOwner("alpha", owner("alpha", holderPid, holderIdentity));
    let nowMs = 2_000;
    let sleepCalls = 0;
    const locker = manager({
      now: () => nowMs,
      sleep: (milliseconds) => {
        sleepCalls += 1;
        nowMs += milliseconds;
        fs.unlinkSync(lockPath);
      },
      isProcessAlive: (pid) => pid === holderPid || pid === SELF_PID,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === holderPid ? holderIdentity : null,
    });

    expect(
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields down", () => "acquired", {
        waitTimeoutMs: 10,
        pollIntervalMs: 1,
      }),
    ).toBe("acquired");
    expect(sleepCalls).toBe(1);
  });

  it("times out without reclaiming a live holder whose identity cannot be read", () => {
    const holderPid = 202;
    const lockPath = writeOwner("alpha", owner("alpha", holderPid, "proc:holder-start"));
    let nowMs = 2_000;
    const locker = manager({
      now: () => nowMs,
      sleep: (milliseconds) => {
        nowMs += milliseconds;
      },
      isProcessAlive: (pid) => pid === holderPid || pid === SELF_PID,
    });

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "timer restore", () => undefined, {
        waitTimeoutMs: 3,
        pollIntervalMs: 1,
      }),
    ).toThrow(/PID 202 is alive but its process-start identity cannot be verified/);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("recovers a stale lock when the parsed holder is dead", () => {
    const recorded = owner("alpha", 202, "proc:dead-holder");
    const lockPath = writeOwner("alpha", recorded);
    const locker = manager();

    expect(
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => {
        const replacement = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        expect(replacement).toMatchObject({
          sandboxName: "alpha",
          pid: SELF_PID,
          processStartIdentity: SELF_IDENTITY,
          command: "nemoclaw alpha shields up",
        });
        return "acquired";
      }),
    ).toBe("acquired");

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("recovers a stale lock when a live PID has been reused", () => {
    const holderPid = 202;
    const recorded = owner("alpha", holderPid, "proc:original");
    const lockPath = writeOwner("alpha", recorded);
    const locker = manager({
      isProcessAlive: (pid) => pid === holderPid || pid === SELF_PID,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === holderPid ? "proc:reused" : null,
    });

    expect(
      locker.withShieldsTransitionLock("alpha", "timer restore", () => {
        const replacement = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        expect(replacement).toMatchObject({
          sandboxName: "alpha",
          pid: SELF_PID,
          processStartIdentity: SELF_IDENTITY,
          command: "timer restore",
        });
        return "acquired";
      }),
    ).toBe("acquired");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("enforces the wait timeout when stale recovery retries without progress", () => {
    const recorded = owner("alpha", 202, "proc:dead-holder");
    const lockPath = writeOwner("alpha", recorded);
    let nowMs = 2_000;
    let raced = false;
    const locker = manager({
      now: () => nowMs,
      isProcessAlive: (pid) => {
        runWhen(pid === 202 && !raced, () => {
          raced = true;
          fs.unlinkSync(lockPath);
          nowMs += 3;
        });
        return pid === SELF_PID;
      },
    });

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => undefined, {
        waitTimeoutMs: 2,
        pollIntervalMs: 1,
      }),
    ).toThrow(/Timed out after 2ms waiting for shields transition lock .*recorded owner PID 202/s);
  });

  it("enforces the async wait timeout when stale recovery retries without progress", async () => {
    const recorded = owner("alpha", 202, "proc:dead-holder");
    const lockPath = writeOwner("alpha", recorded);
    let nowMs = 2_000;
    let raced = false;
    const locker = manager({
      now: () => nowMs,
      isProcessAlive: (pid) => {
        runWhen(pid === 202 && !raced, () => {
          raced = true;
          fs.unlinkSync(lockPath);
          nowMs += 3;
        });
        return pid === SELF_PID;
      },
    });

    await expect(
      locker.withShieldsTransitionLockAsync(
        "alpha",
        "nemoclaw alpha shields up",
        async () => {
          throw new Error("should not acquire after timeout");
        },
        {
          waitTimeoutMs: 2,
          pollIntervalMs: 1,
        },
      ),
    ).rejects.toThrow(
      /Timed out after 2ms waiting for shields transition lock .*recorded owner PID 202/s,
    );
  });

  it("recovers a stale lock asynchronously when the parsed holder is dead", async () => {
    const recorded = owner("alpha", 202, "proc:dead-holder");
    const lockPath = writeOwner("alpha", recorded);
    const locker = manager();

    await expect(
      locker.withShieldsTransitionLockAsync("alpha", "nemoclaw alpha shields up", async () => {
        const replacement = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        expect(replacement).toMatchObject({
          sandboxName: "alpha",
          pid: SELF_PID,
          processStartIdentity: SELF_IDENTITY,
          command: "nemoclaw alpha shields up",
        });
        return "acquired";
      }),
    ).resolves.toBe("acquired");

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("recovers a stale lock asynchronously when a live PID has been reused", async () => {
    const holderPid = 202;
    const recorded = owner("alpha", holderPid, "proc:original");
    const lockPath = writeOwner("alpha", recorded);
    const locker = manager({
      isProcessAlive: (pid) => pid === holderPid || pid === SELF_PID,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === holderPid ? "proc:reused" : null,
    });

    await expect(
      locker.withShieldsTransitionLockAsync("alpha", "timer restore", async () => {
        const replacement = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        expect(replacement).toMatchObject({
          sandboxName: "alpha",
          pid: SELF_PID,
          processStartIdentity: SELF_IDENTITY,
          command: "timer restore",
        });
        return "acquired";
      }),
    ).resolves.toBe("acquired");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("keeps a replacement owner canonical during stale lock recovery races", () => {
    const original = owner("alpha", 202, "proc:dead-holder");
    const replacement = owner("alpha", 303, "proc:replacement", "replacement holder");
    const lockPath = writeOwner("alpha", original);
    const displacedPath = `${lockPath}.displaced`;
    const originalLinkSync = fs.linkSync;
    let raced = false;
    let thirdAcquired = false;
    let thirdError: unknown = null;
    let recoveryNow = 2_000;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      runWhen(String(source) === lockPath && !raced, () => {
        raced = true;
        fs.renameSync(lockPath, displacedPath);
        fs.writeFileSync(lockPath, JSON.stringify(replacement), { mode: 0o600 });
        let thirdNow = 2_000;
        const third = manager({
          now: () => thirdNow,
          sleep: (milliseconds) => {
            thirdNow += milliseconds;
          },
          isProcessAlive: (pid) => pid === SELF_PID || pid === 303,
          readProcessStartIdentity: (pid) =>
            pid === SELF_PID ? SELF_IDENTITY : pid === 303 ? "proc:replacement" : null,
        });
        try {
          third.withShieldsTransitionLock(
            "alpha",
            "third contender",
            () => {
              thirdAcquired = true;
            },
            {
              waitTimeoutMs: 2,
              pollIntervalMs: 1,
            },
          );
        } catch (error) {
          thirdError = error;
        }
      });
      originalLinkSync(source, destination);
    });
    const locker = manager({
      now: () => recoveryNow,
      sleep: (milliseconds) => {
        recoveryNow += milliseconds;
      },
      isProcessAlive: (pid) => pid === SELF_PID || pid === 303,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === 303 ? "proc:replacement" : null,
    });

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => undefined, {
        waitTimeoutMs: 2,
        pollIntervalMs: 1,
      }),
    ).toThrow(/PID 303 is still running/);

    expect(thirdAcquired).toBe(false);
    expect(thirdError).toBeInstanceOf(Error);
    expect(String((thirdError as Error).message)).toMatch(/PID 303 is still running/);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(replacement);
    expect(JSON.parse(fs.readFileSync(displacedPath, "utf8"))).toEqual(original);
  });

  it("blocks contenders at the final stale recovery unlink boundary", () => {
    const recorded = owner("alpha", 202, "proc:dead-holder");
    const lockPath = writeOwner("alpha", recorded);
    const originalUnlinkSync = fs.unlinkSync;
    let raced = false;
    let thirdAcquired = false;
    let thirdError: unknown = null;
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      runWhen(String(target) === lockPath && !raced, () => {
        raced = true;
        let thirdNow = 2_000;
        const third = manager({
          now: () => {
            thirdNow += 1;
            return thirdNow;
          },
          isProcessAlive: (pid) => pid === SELF_PID,
        });
        try {
          third.withShieldsTransitionLock(
            "alpha",
            "third contender",
            () => {
              thirdAcquired = true;
            },
            {
              waitTimeoutMs: 2,
              pollIntervalMs: 1,
            },
          );
        } catch (error) {
          thirdError = error;
        }
      });
      originalUnlinkSync(target);
    });
    const locker = manager();

    expect(
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => "acquired"),
    ).toBe("acquired");

    expect(thirdAcquired).toBe(false);
    expect(thirdError).toBeInstanceOf(Error);
    expect(String((thirdError as Error).message)).toMatch(/recorded owner PID 202/);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("blocks async contenders at the final stale recovery unlink boundary", async () => {
    const recorded = owner("alpha", 202, "proc:dead-holder");
    const lockPath = writeOwner("alpha", recorded);
    const originalUnlinkSync = fs.unlinkSync;
    let raced = false;
    let thirdAcquired = false;
    let thirdPromise: Promise<unknown> = Promise.resolve();
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      runWhen(String(target) === lockPath && !raced, () => {
        raced = true;
        let thirdNow = 2_000;
        const third = manager({
          now: () => {
            thirdNow += 1;
            return thirdNow;
          },
          isProcessAlive: (pid) => pid === SELF_PID,
        });
        thirdPromise = third.withShieldsTransitionLockAsync(
          "alpha",
          "async third contender",
          async () => {
            thirdAcquired = true;
          },
          {
            waitTimeoutMs: 2,
            pollIntervalMs: 1,
          },
        );
      });
      originalUnlinkSync(target);
    });
    const locker = manager();

    await expect(
      locker.withShieldsTransitionLockAsync(
        "alpha",
        "nemoclaw alpha shields up",
        async () => "acquired",
      ),
    ).resolves.toBe("acquired");

    await expect(thirdPromise).rejects.toThrow(/recorded owner PID 202/);
    expect(thirdAcquired).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("recovers a crashed stale guard while the stale canonical owner remains", () => {
    const { lockPath, guardPath } = createRecoveryGuard("alpha");
    fs.writeFileSync(lockPath, JSON.stringify(owner("alpha", 202, "proc:stale")), {
      mode: 0o600,
    });
    writeRecoveryGuardOwner(guardPath, owner("alpha", 203, "proc:recoverer", "stale recovery"));
    const locker = manager();

    expect(
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => {
        expect(fs.existsSync(lockPath)).toBe(true);
        expect(fs.existsSync(guardPath)).toBe(false);
        return "acquired";
      }),
    ).toBe("acquired");

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  it("recovers an orphaned stale recovery guard before acquiring asynchronously", async () => {
    const { lockPath, guardPath } = createRecoveryGuard("alpha");
    fs.writeFileSync(lockPath, JSON.stringify(owner("alpha", 202, "proc:stale")), {
      mode: 0o600,
    });
    writeRecoveryGuardOwner(guardPath, owner("alpha", 202, "proc:recoverer", "stale recovery"));
    const locker = manager();

    await expect(
      locker.withShieldsTransitionLockAsync("alpha", "nemoclaw alpha shields up", async () => {
        expect(fs.existsSync(lockPath)).toBe(true);
        expect(fs.existsSync(guardPath)).toBe(false);
        return "acquired";
      }),
    ).resolves.toBe("acquired");

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  it("does not let an orphaned recovery-owner temp file block acquisition", () => {
    const { lockPath, guardPath } = createRecoveryGuard("alpha");
    const orphanedTemp = `${guardPath}.acquire-202-${"a".repeat(32)}.tmp`;
    fs.writeFileSync(orphanedTemp, "{incomplete", { mode: 0o600 });
    const locker = manager();

    expect(
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => {
        expect(fs.existsSync(lockPath)).toBe(true);
        expect(fs.existsSync(guardPath)).toBe(false);
        return "acquired";
      }),
    ).toBe("acquired");

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(guardPath)).toBe(false);
    expect(fs.existsSync(orphanedTemp)).toBe(true);
  });

  it("keeps a live stale recovery guard owner protected", () => {
    const { lockPath, guardPath } = createRecoveryGuard("alpha");
    writeRecoveryGuardOwner(guardPath, owner("alpha", 202, "proc:guard", "stale recovery"));
    let nowMs = 2_000;
    const locker = manager({
      now: () => {
        nowMs += 1;
        return nowMs;
      },
      sleep: (milliseconds) => {
        nowMs += milliseconds;
      },
      isProcessAlive: (pid) => pid === SELF_PID || pid === 202,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === 202 ? "proc:guard" : null,
    });

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => "unexpected", {
        waitTimeoutMs: 2,
        pollIntervalMs: 1,
      }),
    ).toThrow(/the lock changed during inspection/);

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(guardPath)).toBe(true);
  });

  it("does not remove a replacement recovery guard during orphan cleanup", () => {
    const { lockPath, guardPath } = createRecoveryGuard("alpha");
    writeRecoveryGuardOwner(guardPath, owner("alpha", 203, "proc:stale", "stale recovery"));
    const originalRenameSync = fs.renameSync;
    let raced = false;
    let callbackRan = false;
    let replacementSnapshot: ReturnType<typeof readLockFileSnapshot> | null = null;
    let nowMs = 2_000;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      runWhen(String(source) === guardPath && !raced, () => {
        raced = true;
        fs.unlinkSync(guardPath);
        writeRecoveryGuardOwner(guardPath, owner("alpha", 202, "proc:guard", "stale recovery"));
        replacementSnapshot = readLockFileSnapshot(guardPath);
      });
      originalRenameSync(source, destination);
    });
    const locker = manager({
      now: () => {
        nowMs += 1;
        return nowMs;
      },
      isProcessAlive: (pid) => pid === SELF_PID || pid === 202,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === 202 ? "proc:guard" : null,
    });

    expect(() =>
      locker.withShieldsTransitionLock(
        "alpha",
        "nemoclaw alpha shields up",
        () => {
          callbackRan = true;
        },
        {
          waitTimeoutMs: 2,
          pollIntervalMs: 1,
        },
      ),
    ).toThrow(/the lock changed during inspection/);

    expect(raced).toBe(true);
    expect(callbackRan).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(guardPath)).toBe(true);
    expect(readLockFileSnapshot(guardPath)).toEqual(replacementSnapshot);
    expect(JSON.parse(fs.readFileSync(guardPath, "utf8"))).toMatchObject({
      pid: 202,
      processStartIdentity: "proc:guard",
    });
    const preserved = fs
      .readdirSync(stateDir)
      .filter((entry) => entry.startsWith(`${path.basename(guardPath)}.stale-`));
    expect(preserved).toHaveLength(1);
    expect(readLockFileSnapshot(path.join(stateDir, preserved[0]!, "owner.json"))).toEqual(
      replacementSnapshot,
    );
  });

  it("preserves a replacement installed while releasing a held recovery guard", () => {
    const recorded = owner("alpha", 203, "proc:stale");
    const lockPath = writeOwner("alpha", recorded);
    const guardPath = `${lockPath}.recovering`;
    const originalRenameSync = fs.renameSync;
    let raced = false;
    let callbackRan = false;
    let replacementSnapshot: ReturnType<typeof readLockFileSnapshot> | null = null;
    let nowMs = 2_000;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      runWhen(
        String(source) === guardPath &&
          String(destination).includes(".recovery-release-") &&
          !raced,
        () => {
          raced = true;
          fs.unlinkSync(guardPath);
          writeRecoveryGuardOwner(guardPath, owner("alpha", 202, "proc:guard", "stale recovery"));
          replacementSnapshot = readLockFileSnapshot(guardPath);
        },
      );
      originalRenameSync(source, destination);
    });
    const locker = manager({
      now: () => {
        nowMs += 1;
        return nowMs;
      },
      isProcessAlive: (pid) => pid === SELF_PID || pid === 202,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === 202 ? "proc:guard" : null,
    });

    expect(() =>
      locker.withShieldsTransitionLock(
        "alpha",
        "nemoclaw alpha shields up",
        () => {
          callbackRan = true;
        },
        {
          waitTimeoutMs: 2,
          pollIntervalMs: 1,
        },
      ),
    ).toThrow(/Timed out after 2ms/);

    expect(raced).toBe(true);
    expect(callbackRan).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(readLockFileSnapshot(guardPath)).toEqual(replacementSnapshot);
    expect(JSON.parse(fs.readFileSync(guardPath, "utf8"))).toMatchObject({
      pid: 202,
      processStartIdentity: "proc:guard",
    });
  });

  it("waits on a recent malformed owner record", () => {
    const lockPath = writeOwner("alpha", "{incomplete");
    const initialSnapshot = readLockFileSnapshot(lockPath);
    let nowMs = initialSnapshot.mtimeMs + 5;
    const locker = manager({
      now: () => nowMs,
      sleep: (milliseconds) => {
        nowMs += milliseconds;
      },
    });

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "timer restore", () => undefined, {
        waitTimeoutMs: 3,
        pollIntervalMs: 1,
        malformedStaleMs: 30_000,
      }),
    ).toThrow(/owner record is incomplete/);
    const finalSnapshot = readLockFileSnapshot(lockPath);
    expect(finalSnapshot.inode).toBe(initialSnapshot.inode);
    expect(finalSnapshot.contents).toBe("{incomplete");
  });

  it("fails closed with manual recovery guidance for an old malformed owner record", () => {
    const lockPath = writeOwner("alpha", "{incomplete");
    fs.utimesSync(lockPath, new Date(1_000), new Date(1_000));
    let nowMs = 60_000;
    const locker = manager({
      now: () => nowMs,
      sleep: (milliseconds) => {
        nowMs += milliseconds;
      },
    });

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => undefined, {
        waitTimeoutMs: 2,
        pollIntervalMs: 1,
        malformedStaleMs: 30_000,
      }),
    ).toThrow(/owner record is incomplete.*will not remove.*remove '.*' manually/s);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("{incomplete");
  });

  it.skipIf(process.platform === "win32")("rejects symbolic-link lock paths", () => {
    const target = path.join(root, "target");
    fs.writeFileSync(target, "{}", { mode: 0o600 });
    const symlinkPath = shieldsTransitionLockPath("symlinked", stateDir);
    fs.symlinkSync(target, symlinkPath);
    const locker = manager();

    expect(() =>
      locker.withShieldsTransitionLock("symlinked", "shields up", () => undefined),
    ).toThrow(/symbolic links are not allowed/);
  });

  it("rejects non-regular lock paths", () => {
    const directoryPath = shieldsTransitionLockPath("directory", stateDir);
    fs.mkdirSync(directoryPath);
    const locker = manager();

    expect(() =>
      locker.withShieldsTransitionLock("directory", "shields up", () => undefined),
    ).toThrow(/path is not a regular file/);
  });

  it("keeps one inode across reentrant calls and releases only at depth zero", () => {
    const locker = manager();
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);

    locker.withShieldsTransitionLock("alpha", "outer transition", () => {
      const outerSnapshot = readLockFileSnapshot(lockPath);
      locker.withShieldsTransitionLock("alpha", "inner transition", () => {
        const innerSnapshot = readLockFileSnapshot(lockPath);
        expect(innerSnapshot.inode).toBe(outerSnapshot.inode);
        expect(JSON.parse(innerSnapshot.contents).command).toBe("outer transition");
      });
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("uses independent lock files for different sandboxes", () => {
    const locker = manager();
    const alphaPath = shieldsTransitionLockPath("alpha", stateDir);
    const betaPath = shieldsTransitionLockPath("beta", stateDir);

    locker.withShieldsTransitionLock("alpha", "alpha transition", () => {
      locker.withShieldsTransitionLock("beta", "beta transition", () => {
        expect(fs.existsSync(alphaPath)).toBe(true);
        expect(fs.existsSync(betaPath)).toBe(true);
      });
      expect(fs.existsSync(alphaPath)).toBe(true);
      expect(fs.existsSync(betaPath)).toBe(false);
    });

    expect(fs.existsSync(alphaPath)).toBe(false);
  });

  it("uses the held descriptor to avoid removing a replacement during release", () => {
    const locker = manager();
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);
    const displacedPath = `${lockPath}.displaced`;
    const replacement = owner("alpha", 303, "proc:replacement", "replacement holder");

    locker.withShieldsTransitionLock("alpha", "outer transition", () => {
      fs.renameSync(lockPath, displacedPath);
      fs.writeFileSync(lockPath, JSON.stringify(replacement), { mode: 0o600 });
    });

    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(replacement);
    expect(fs.existsSync(displacedPath)).toBe(true);
  });

  it("preserves a replacement installed at the exact release rename boundary", () => {
    const locker = manager();
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);
    const displacedPath = `${lockPath}.original`;
    const replacement = owner("alpha", 303, "proc:replacement", "replacement holder");
    const originalRename = fs.renameSync.bind(fs);
    let armRace = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      runWhen(
        armRace && String(source) === lockPath && String(destination).includes(".release-"),
        () => {
          armRace = false;
          originalRename(lockPath, displacedPath);
          fs.writeFileSync(lockPath, JSON.stringify(replacement), { mode: 0o600 });
        },
      );
      return originalRename(source, destination);
    });

    locker.withShieldsTransitionLock("alpha", "outer transition", () => {
      armRace = true;
    });

    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(replacement);
    expect(fs.existsSync(displacedPath)).toBe(true);
    const quarantines = fs
      .readdirSync(stateDir)
      .filter((name) => name.startsWith(`${path.basename(lockPath)}.release-`));
    expect(quarantines).toHaveLength(1);
  });

  it("releases the lock when the protected callback throws", () => {
    const locker = manager();
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "shields up", () => {
        throw new Error("transition failed");
      }),
    ).toThrow("transition failed");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("holds the lock across an asynchronous callback and releases after settlement", async () => {
    const locker = manager();
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);
    let releaseCallback: (() => void) | undefined;
    const pending = locker.withShieldsTransitionLockAsync(
      "alpha",
      "async config mutation",
      async () => {
        expect(fs.existsSync(lockPath)).toBe(true);
        await new Promise<void>((resolve) => {
          releaseCallback = resolve;
        });
        expect(fs.existsSync(lockPath)).toBe(true);
        return "complete";
      },
    );

    await vi.waitFor(() => expect(releaseCallback).toBeTypeOf("function"));
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseCallback?.();
    await expect(pending).resolves.toBe("complete");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("allows reentrancy only inside the owning asynchronous chain", async () => {
    const sleepAsync = vi.fn(async () => {});
    const locker = manager({ sleepAsync });
    const lockPath = shieldsTransitionLockPath("alpha", stateDir);

    await expect(
      locker.withShieldsTransitionLockAsync("alpha", "outer async transition", async () => {
        const outerSnapshot = readLockFileSnapshot(lockPath);
        await Promise.resolve();
        await locker.withShieldsTransitionLockAsync("alpha", "inner async transition", async () => {
          const innerSnapshot = readLockFileSnapshot(lockPath);
          expect(innerSnapshot.inode).toBe(outerSnapshot.inode);
          expect(JSON.parse(innerSnapshot.contents).command).toBe("outer async transition");
        });
        expect(fs.existsSync(lockPath)).toBe(true);
      }),
    ).resolves.toBeUndefined();

    expect(sleepAsync).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("serializes unrelated concurrent async calls in the same process", async () => {
    let nowMs = 2_000;
    let releaseFirst: (() => void) | undefined;
    const events: string[] = [];
    const locker = manager({
      now: () => nowMs,
      sleepAsync: async (milliseconds) => {
        nowMs += milliseconds;
        const release = releaseFirst;
        releaseFirst = undefined;
        release?.();
        await Promise.resolve();
      },
    });

    const first = locker.withShieldsTransitionLockAsync(
      "alpha",
      "first async transition",
      async () => {
        events.push("first-enter");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        events.push("first-exit");
        return "first";
      },
    );
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));

    const second = locker.withShieldsTransitionLockAsync(
      "alpha",
      "second async transition",
      async () => {
        events.push("second-enter");
        return "second";
      },
      { waitTimeoutMs: 10, pollIntervalMs: 1 },
    );

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });
});
