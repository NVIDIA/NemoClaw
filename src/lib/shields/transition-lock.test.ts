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
      expect(snapshot.mode).toBe(0o600n);
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

  it("preserves a replacement raced into the token-specific quarantine", () => {
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
    const originalRenameSync = fs.renameSync;
    let raced = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      runWhen(String(source) === lockPath && !raced, () => {
        raced = true;
        originalRenameSync(lockPath, displacedPath);
        fs.writeFileSync(lockPath, JSON.stringify(replacement), { mode: 0o600 });
      });
      originalRenameSync(source, destination);
    });
    const locker = manager({
      isProcessAlive: (pid) => pid === SELF_PID || pid === 303,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === 303 ? "proc:replacement" : null,
    });

    const result = locker.takeoverShieldsTransitionLock("alpha", 202, "proc:owner", TAKEOVER_TOKEN);

    expect(result).toMatchObject({ removed: false, reason: "replacement-preserved" });
    expect(result.quarantinePath).toContain(`.takeover-${TAKEOVER_TOKEN}-`);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(replacement);
    expect(JSON.parse(fs.readFileSync(result.quarantinePath!, "utf8"))).toEqual(replacement);
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

  it("fails closed with recovery guidance when the recorded holder is dead", () => {
    const recorded = owner("alpha", 202, "proc:dead-holder");
    const lockPath = writeOwner("alpha", recorded);
    const liveness = vi.fn((pid: number) => pid === SELF_PID);
    let nowMs = 2_000;
    const locker = manager({
      now: () => nowMs,
      sleep: (milliseconds) => {
        nowMs += milliseconds;
      },
      isProcessAlive: liveness,
    });
    const unlink = vi.spyOn(fs, "unlinkSync");

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "nemoclaw alpha shields up", () => undefined, {
        waitTimeoutMs: 2,
        pollIntervalMs: 1,
      }),
    ).toThrow(/will not remove a stale lock pathname automatically.*remove '.*' manually/s);

    expect(liveness).toHaveBeenCalledWith(202);
    expect(unlink).not.toHaveBeenCalledWith(lockPath);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(recorded);
  });

  it("fails closed with recovery guidance when a live PID has been reused", () => {
    const holderPid = 202;
    const recorded = owner("alpha", holderPid, "proc:original");
    const lockPath = writeOwner("alpha", recorded);
    let nowMs = 2_000;
    const locker = manager({
      now: () => nowMs,
      sleep: (milliseconds) => {
        nowMs += milliseconds;
      },
      isProcessAlive: (pid) => pid === holderPid || pid === SELF_PID,
      readProcessStartIdentity: (pid) =>
        pid === SELF_PID ? SELF_IDENTITY : pid === holderPid ? "proc:reused" : null,
    });

    expect(() =>
      locker.withShieldsTransitionLock("alpha", "timer restore", () => undefined, {
        waitTimeoutMs: 2,
        pollIntervalMs: 1,
      }),
    ).toThrow(/now has process-start identity 'proc:reused'.*remove '.*' manually/s);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(recorded);
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

  it("rejects symbolic-link and non-regular lock paths", () => {
    const target = path.join(root, "target");
    fs.writeFileSync(target, "{}", { mode: 0o600 });
    const symlinkPath = shieldsTransitionLockPath("symlinked", stateDir);
    fs.symlinkSync(target, symlinkPath);
    const directoryPath = shieldsTransitionLockPath("directory", stateDir);
    fs.mkdirSync(directoryPath);
    const locker = manager();

    expect(() =>
      locker.withShieldsTransitionLock("symlinked", "shields up", () => undefined),
    ).toThrow(/symbolic links are not allowed/);
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
