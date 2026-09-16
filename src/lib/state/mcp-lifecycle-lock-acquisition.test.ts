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
import { getMcpLifecycleLockPath } from "./mcp-lifecycle-lock-storage";

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

  describe.each([
    {
      mode: "asynchronous",
      acquire: (operation: () => string, overrides: Record<string, number> = {}) =>
        withMcpLifecycleLock("alpha", operation, options(overrides)),
      loseLinkReply: () => {
        const link = fs.promises.link;
        vi.spyOn(fs.promises, "link").mockImplementationOnce(async (...args) => {
          await link(...args);
          throw Object.assign(new Error("lost publication reply"), { code: "EIO" });
        });
      },
    },
    {
      mode: "synchronous",
      acquire: async (operation: () => string, overrides: Record<string, number> = {}) =>
        withMcpLifecycleLockSync("alpha", operation, options(overrides)),
      loseLinkReply: () => {
        const link = fs.linkSync;
        vi.spyOn(fs, "linkSync").mockImplementationOnce((...args) => {
          link(...args);
          throw Object.assign(new Error("lost publication reply"), { code: "EIO" });
        });
      },
    },
  ])("$mode publication and release", ({ acquire, loseLinkReply }) => {
    it("enters after a lost link reply and removes its owner after operation failure", async () => {
      const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
      const operation = vi.fn(() => {
        expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
          version: 1,
          sandboxName: "alpha",
          pid: process.pid,
          token: expect.any(String),
        });
        expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
        throw new Error("protected operation failed");
      });
      loseLinkReply();

      await expect(acquire(operation)).rejects.toThrow("protected operation failed");

      expect(operation).toHaveBeenCalledOnce();
      expect(fs.readdirSync(path.dirname(lockPath))).toEqual([]);
      await expect(acquire(() => "reacquired")).resolves.toBe("reacquired");
      expect(fs.readdirSync(path.dirname(lockPath))).toEqual([]);
    });

    it("preserves a replacement owner when the protected operation finishes", async () => {
      const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
      const replacement = createMcpLifecycleLockOwner("alpha", "replacement-owner");

      await expect(
        acquire(() => {
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, JSON.stringify(replacement), { flag: "wx", mode: 0o600 });
          return "complete";
        }),
      ).resolves.toBe("complete");

      expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(replacement);
      expect(fs.readdirSync(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
    });

    it("reclaims a lock symlink without reading or removing its target", async () => {
      const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
      const targetPath = path.join(stateDir, "protected-owner.json");
      const targetOwner = JSON.stringify(createMcpLifecycleLockOwner("alpha", "target-owner"));
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(targetPath, targetOwner, { mode: 0o600 });
      fs.symlinkSync(targetPath, lockPath);

      await expect(acquire(() => "acquired")).resolves.toBe("acquired");

      expect(fs.readFileSync(targetPath, "utf8")).toBe(targetOwner);
      expect(fs.readdirSync(path.dirname(lockPath))).toEqual([]);
    });

    it("refuses a lock directory without removing its contents", async () => {
      const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "preserved"), "original");
      const operation = vi.fn(() => "must not run");

      await expect(acquire(operation, { timeoutMs: 20 })).rejects.toThrow(
        "Timed out waiting for the sandbox mutation lock",
      );

      expect(operation).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(lockPath, "preserved"), "utf8")).toBe("original");
      expect(fs.readdirSync(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
    });

    it("reclaims an invalid owner record after observing the same corrupt generation", async () => {
      const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ token: "invalid-owner" }));

      await expect(acquire(() => "acquired")).resolves.toBe("acquired");

      expect(fs.readdirSync(path.dirname(lockPath))).toEqual([]);
    });
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
});
