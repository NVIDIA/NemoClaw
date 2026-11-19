// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMcpLifecycleLockHeld,
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "./mcp-lifecycle-lock-acquisition";
import {
  createMcpLifecycleLockOwner,
  readMcpLockHostIdentity,
  readMcpLockPidNamespaceIdentity,
} from "./mcp-lifecycle-lock-identity";
import {
  getMcpLifecycleLockPath,
  mcpLifecycleLockPathExists,
  mcpLifecycleLockPathExistsSync,
  readMcpLifecycleLockObservation,
  readMcpLifecycleLockObservationSync,
  safelyReleaseMcpLifecycleLock,
  safelyReleaseMcpLifecycleLockSync,
} from "./mcp-lifecycle-lock-storage";

describe("sandbox mutation lock acquisition", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mutation-lock-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const options = (overrides: Record<string, number> = {}) => ({
    stateDir,
    pollIntervalMs: 1,
    timeoutMs: 1_000,
    corruptLockGraceMs: 5,
    ...overrides,
  });

  it("serializes separate asynchronous operations", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstWaiting = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = withMcpLifecycleLock(
      "alpha",
      async () => {
        events.push("first-enter");
        firstEntered();
        await firstWaiting;
        events.push("first-exit");
      },
      options(),
    );
    await firstStarted;
    const second = withMcpLifecycleLock(
      "alpha",
      () => {
        events.push("second-enter");
      },
      options(),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first-enter"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("allows nested acquisition only while the inherited lease is active", async () => {
    let detached!: () => Promise<void>;
    await withMcpLifecycleLock(
      "alpha",
      async () => {
        expect(isMcpLifecycleLockHeld("alpha", stateDir)).toBe(true);
        await withMcpLifecycleLock(
          "alpha",
          () => expect(isMcpLifecycleLockHeld("alpha", stateDir)).toBe(true),
          options(),
        );
        detached = () =>
          withMcpLifecycleLock(
            "alpha",
            () => expect(isMcpLifecycleLockHeld("alpha", stateDir)).toBe(true),
            options(),
          );
      },
      options(),
    );
    expect(isMcpLifecycleLockHeld("alpha", stateDir)).toBe(false);
    await detached();
  });

  it("supports synchronous acquisition and nested calls", () => {
    const result = withMcpLifecycleLockSync(
      "alpha",
      () =>
        withMcpLifecycleLockSync(
          "alpha",
          () => {
            expect(isMcpLifecycleLockHeld("alpha", stateDir)).toBe(true);
            return "complete";
          },
          options(),
        ),
      options(),
    );
    expect(result).toBe("complete");
    expect(isMcpLifecycleLockHeld("alpha", stateDir)).toBe(false);
  });

  it("reclaims a stale local owner through the reaper generation", async () => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        ...createMcpLifecycleLockOwner("alpha", "stale"),
        pid: 2_147_483_647,
        processIdentity: "departed",
        hostIdentity: readMcpLockHostIdentity(),
        pidNamespaceIdentity: readMcpLockPidNamespaceIdentity(),
      }),
    );
    await expect(withMcpLifecycleLock("alpha", () => "acquired", options())).resolves.toBe(
      "acquired",
    );
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.reaper`)).toBe(false);
  });

  it("fails closed on a foreign live owner", async () => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        ...createMcpLifecycleLockOwner("alpha", "foreign"),
        hostIdentity: "foreign-host",
      }),
    );
    await expect(
      withMcpLifecycleLock("alpha", () => undefined, options({ timeoutMs: 20 })),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ token: "foreign" });
  });

  const lockers = [
    [
      "async",
      (opts: Parameters<typeof withMcpLifecycleLock>[2]) =>
        withMcpLifecycleLock("alpha", () => undefined, opts),
    ],
    [
      "sync",
      (opts: Parameters<typeof withMcpLifecycleLock>[2]) =>
        Promise.resolve().then(() => withMcpLifecycleLockSync("alpha", () => undefined, opts)),
    ],
  ] as const;

  const writeForeignLock = (pid: number, suffix = "") => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    const ownerPath = `${lockPath}${suffix}`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const record = JSON.stringify({
      ...createMcpLifecycleLockOwner("alpha", `foreign-${String(pid)}`),
      pid,
      hostIdentity: "foreign-host",
    });
    fs.writeFileSync(`${lockPath}.next`, record);
    fs.renameSync(`${lockPath}.next`, ownerPath);
    return ownerPath;
  };

  const blockedWaits = lockers.flatMap(([name, run]) =>
    (
      [
        ["lock", ""],
        ["reaper", ".reaper"],
      ] as const
    ).map(([owner, suffix]) => [`${name}, ${owner}`, run, suffix] as const),
  );

  const steppedClock = (stepMs: number) => {
    let now = 0;
    return { read: () => now, monotonicNow: () => (now += stepMs) };
  };

  const elapsedClock = (scale: number) => {
    const startedAt = performance.now();
    const read = () => (performance.now() - startedAt) * scale;
    return { read, monotonicNow: read };
  };

  it.each(blockedWaits)(
    "prints one wait notice after the default delay (%s)",
    async (_name, run, suffix) => {
      const ownerPath = writeForeignLock(4242, suffix);
      const clock = elapsedClock(100);
      const notices: Array<{ message: string; at: number }> = [];
      await expect(
        run({
          ...options({ timeoutMs: 20_000 }),
          monotonicNow: clock.monotonicNow,
          writeNotice: (message) => notices.push({ message, at: clock.read() }),
        }),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
      expect(notices).toHaveLength(1);
      expect(notices[0].at).toBeGreaterThanOrEqual(10_000);
      expect(notices[0].message).toContain("PID 4242");
      expect(notices[0].message).toContain(`Lock file: ${ownerPath}.`);

      notices.length = 0;
      const shortClock = elapsedClock(100);
      await expect(
        run({
          ...options({ timeoutMs: 9_900 }),
          monotonicNow: shortClock.monotonicNow,
          writeNotice: (message) => notices.push({ message, at: shortClock.read() }),
        }),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
      expect(notices).toEqual([]);
    },
  );

  it.each(lockers)("times the notice from each new lock owner (%s)", async (_name, run) => {
    writeForeignLock(4242);
    const clock = elapsedClock(100);
    const notices: Array<{ message: string; at: number }> = [];
    let replacedAt = 0;
    const afterNotice = [
      () => {
        writeForeignLock(4343);
        replacedAt = clock.read();
      },
    ];
    await expect(
      run({
        ...options({ timeoutMs: 20_000, waitNoticeMs: 3_000 }),
        monotonicNow: clock.monotonicNow,
        writeNotice: (message) => {
          notices.push({ message, at: clock.read() });
          afterNotice.shift()?.();
        },
      }),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    expect(notices).toHaveLength(2);
    expect(notices[1].message).toContain("PID 4343");
    expect(notices[1].at - replacedAt).toBeGreaterThanOrEqual(3_000);
  });

  it.each(lockers)(
    "gives no foreign-owner advice for an unreadable lock (%s)",
    async (_name, run) => {
      const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, "not-json");
      const clock = steppedClock(1_000);
      const notices: string[] = [];
      await expect(
        run({
          ...options({ timeoutMs: 8_000, waitNoticeMs: 2_000, corruptLockGraceMs: 100_000 }),
          monotonicNow: clock.monotonicNow,
          writeNotice: (message) => notices.push(message),
        }),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("unreadable");
      expect(notices[0]).not.toContain("PID");
    },
  );

  it.each(lockers)("acquires the lock after a notice callback throws (%s)", async (_name, run) => {
    const lockPath = writeForeignLock(4242);
    const clock = steppedClock(1_000);
    await expect(
      run({
        ...options({ timeoutMs: 30_000, waitNoticeMs: 1_000 }),
        monotonicNow: clock.monotonicNow,
        writeNotice: () => {
          fs.rmSync(lockPath);
          throw new Error("notice failed");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it.each(lockers)("acquires the lock after a notice callback rejects (%s)", async (_name, run) => {
    const lockPath = writeForeignLock(4242);
    const clock = steppedClock(1_000);
    await expect(
      run({
        ...options({ timeoutMs: 30_000, waitNoticeMs: 1_000 }),
        monotonicNow: clock.monotonicNow,
        writeNotice: (() => {
          fs.rmSync(lockPath);
          return Promise.reject(new Error("notice failed"));
        }) as () => void,
      }),
    ).resolves.toBeUndefined();
  });

  it.each(lockers)("does not wait for a stalled stderr write (%s)", async (_name, run) => {
    const lockPath = writeForeignLock(4242);
    const write = vi.spyOn(fs, "write").mockImplementationOnce((() => {
      fs.rmSync(lockPath);
    }) as unknown as typeof fs.write);
    try {
      const clock = steppedClock(1_000);
      await expect(
        run({
          ...options({ timeoutMs: 30_000, waitNoticeMs: 1_000 }),
          monotonicNow: clock.monotonicNow,
        }),
      ).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledWith(
        2,
        expect.stringContaining(lockPath),
        expect.any(Function),
      );
    } finally {
      write.mockRestore();
    }
  });

  it.each(lockers)("keeps one stderr write in flight (%s)", async (_name, run) => {
    writeForeignLock(4242);
    const write = vi.spyOn(fs, "write").mockImplementation((() => {
      writeForeignLock(4343);
    }) as unknown as typeof fs.write);
    try {
      const clock = steppedClock(1_000);
      await expect(
        run({
          ...options({ timeoutMs: 30_000, waitNoticeMs: 1_000 }),
          monotonicNow: clock.monotonicNow,
        }),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  });

  it("reclaims a continuously corrupt main generation after the grace period", async () => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "not-json");
    await expect(withMcpLifecycleLock("alpha", () => "acquired", options())).resolves.toBe(
      "acquired",
    );
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims a stale reaper before entering the protected operation", async () => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      `${lockPath}.reaper`,
      JSON.stringify({
        ...createMcpLifecycleLockOwner("alpha", "stale-reaper"),
        pid: 2_147_483_647,
        processIdentity: "departed",
      }),
    );
    await expect(withMcpLifecycleLock("alpha", () => "acquired", options())).resolves.toBe(
      "acquired",
    );
    expect(fs.existsSync(`${lockPath}.reaper`)).toBe(false);
  });

  it("times out before aging a corrupt owner when the grace exceeds the timeout", async () => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "not-json");
    await expect(
      withMcpLifecycleLock(
        "alpha",
        () => undefined,
        options({ timeoutMs: 10, corruptLockGraceMs: 100 }),
      ),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    expect(fs.existsSync(`${lockPath}.reaper`)).toBe(false);
  });

  it("observes absent and present lock generations through async and sync storage", async () => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    expect(await mcpLifecycleLockPathExists(lockPath)).toBe(false);
    expect(mcpLifecycleLockPathExistsSync(lockPath)).toBe(false);
    expect(await readMcpLifecycleLockObservation(lockPath)).toBeNull();
    expect(readMcpLifecycleLockObservationSync(lockPath)).toBeNull();

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const owner = createMcpLifecycleLockOwner("alpha", "storage-owner");
    fs.writeFileSync(lockPath, `${JSON.stringify(owner)}\n`);

    expect(await mcpLifecycleLockPathExists(lockPath)).toBe(true);
    expect(mcpLifecycleLockPathExistsSync(lockPath)).toBe(true);
    expect(await readMcpLifecycleLockObservation(lockPath)).toMatchObject({
      owner,
      reclaimable: true,
    });
    expect(readMcpLifecycleLockObservationSync(lockPath)).toMatchObject({
      owner,
      reclaimable: true,
    });
  });

  it("classifies malformed files, directories, and symlinks without following them", async () => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "not-json");
    expect(await readMcpLifecycleLockObservation(lockPath)).toMatchObject({
      owner: null,
      reclaimable: true,
    });
    expect(readMcpLifecycleLockObservationSync(lockPath)).toMatchObject({
      owner: null,
      reclaimable: true,
    });

    fs.rmSync(lockPath);
    fs.mkdirSync(lockPath);
    expect(await readMcpLifecycleLockObservation(lockPath)).toMatchObject({
      owner: null,
      reclaimable: false,
    });
    expect(readMcpLifecycleLockObservationSync(lockPath)).toMatchObject({
      owner: null,
      reclaimable: false,
    });

    fs.rmdirSync(lockPath);
    fs.symlinkSync("missing-target", lockPath);
    expect(await readMcpLifecycleLockObservation(lockPath)).toMatchObject({
      owner: null,
      reclaimable: true,
    });
    expect(readMcpLifecycleLockObservationSync(lockPath)).toMatchObject({
      owner: null,
      reclaimable: true,
    });
  });

  it("releases only the exact async and sync lock-owner token", async () => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const owner = createMcpLifecycleLockOwner("alpha", "release-owner");
    const publish = () => fs.writeFileSync(lockPath, `${JSON.stringify(owner)}\n`);

    publish();
    await safelyReleaseMcpLifecycleLock(lockPath, "other-owner");
    expect(fs.existsSync(lockPath)).toBe(true);
    await safelyReleaseMcpLifecycleLock(lockPath, owner.token);
    expect(fs.existsSync(lockPath)).toBe(false);

    publish();
    safelyReleaseMcpLifecycleLockSync(lockPath, "other-owner");
    expect(fs.existsSync(lockPath)).toBe(true);
    safelyReleaseMcpLifecycleLockSync(lockPath, owner.token);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
