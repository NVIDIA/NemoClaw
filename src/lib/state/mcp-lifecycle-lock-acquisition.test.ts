// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  reclaimStaleMcpLifecycleLockGeneration,
  reclaimStaleMcpLifecycleLockGenerationSync,
  safelyReleaseMcpLifecycleLock,
  safelyReleaseMcpLifecycleLockSync,
  writeMcpLifecycleLockCandidateAndLink,
  writeMcpLifecycleLockCandidateAndLinkSync,
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

  it("observes missing, corrupt, and valid lock generations through both storage paths", async () => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    await expect(mcpLifecycleLockPathExists(lockPath)).resolves.toBe(false);
    expect(mcpLifecycleLockPathExistsSync(lockPath)).toBe(false);
    await expect(readMcpLifecycleLockObservation(lockPath)).resolves.toBeNull();
    expect(readMcpLifecycleLockObservationSync(lockPath)).toBeNull();

    fs.writeFileSync(lockPath, "not-json");
    await expect(mcpLifecycleLockPathExists(lockPath)).resolves.toBe(true);
    expect(mcpLifecycleLockPathExistsSync(lockPath)).toBe(true);
    await expect(readMcpLifecycleLockObservation(lockPath)).resolves.toMatchObject({
      owner: null,
      reclaimable: true,
    });
    expect(readMcpLifecycleLockObservationSync(lockPath)).toMatchObject({
      owner: null,
      reclaimable: true,
    });

    const owner = createMcpLifecycleLockOwner("alpha", "observed");
    fs.writeFileSync(lockPath, `${JSON.stringify(owner)}\n`);
    await expect(readMcpLifecycleLockObservation(lockPath)).resolves.toMatchObject({ owner });
    expect(readMcpLifecycleLockObservationSync(lockPath)).toMatchObject({ owner });
  });

  it("publishes, rejects collisions, and releases only the matching owner token", async () => {
    const asyncPath = getMcpLifecycleLockPath("async", stateDir);
    const syncPath = getMcpLifecycleLockPath("sync", stateDir);
    fs.mkdirSync(path.dirname(asyncPath), { recursive: true });
    const asyncOwner = createMcpLifecycleLockOwner("async", "async-owner");
    const syncOwner = createMcpLifecycleLockOwner("sync", "sync-owner");

    await expect(writeMcpLifecycleLockCandidateAndLink(asyncPath, asyncOwner)).resolves.toBe(true);
    await expect(
      writeMcpLifecycleLockCandidateAndLink(
        asyncPath,
        createMcpLifecycleLockOwner("async", "async-collision"),
      ),
    ).resolves.toBe(false);
    await safelyReleaseMcpLifecycleLock(asyncPath, "wrong-token");
    expect(fs.existsSync(asyncPath)).toBe(true);
    await safelyReleaseMcpLifecycleLock(asyncPath, asyncOwner.token);
    expect(fs.existsSync(asyncPath)).toBe(false);

    expect(writeMcpLifecycleLockCandidateAndLinkSync(syncPath, syncOwner)).toBe(true);
    expect(
      writeMcpLifecycleLockCandidateAndLinkSync(
        syncPath,
        createMcpLifecycleLockOwner("sync", "sync-collision"),
      ),
    ).toBe(false);
    safelyReleaseMcpLifecycleLockSync(syncPath, "wrong-token");
    expect(fs.existsSync(syncPath)).toBe(true);
    safelyReleaseMcpLifecycleLockSync(syncPath, syncOwner.token);
    expect(fs.existsSync(syncPath)).toBe(false);
  });

  it("classifies non-file lock paths without following symbolic links", async () => {
    const directoryPath = getMcpLifecycleLockPath("directory", stateDir);
    const symlinkPath = getMcpLifecycleLockPath("symlink", stateDir);
    fs.mkdirSync(directoryPath, { recursive: true });
    fs.symlinkSync(directoryPath, symlinkPath);

    await expect(readMcpLifecycleLockObservation(directoryPath)).resolves.toMatchObject({
      owner: null,
      reclaimable: false,
    });
    expect(readMcpLifecycleLockObservationSync(directoryPath)).toMatchObject({
      owner: null,
      reclaimable: false,
    });
    await expect(readMcpLifecycleLockObservation(symlinkPath)).resolves.toMatchObject({
      owner: null,
      reclaimable: true,
    });
    expect(readMcpLifecycleLockObservationSync(symlinkPath)).toMatchObject({
      owner: null,
      reclaimable: true,
    });
  });

  it("restores claimed generations after assertion failure or owner drift", async () => {
    const asyncPath = getMcpLifecycleLockPath("async-reclaim", stateDir);
    const syncPath = getMcpLifecycleLockPath("sync-reclaim", stateDir);
    fs.mkdirSync(path.dirname(asyncPath), { recursive: true });
    const asyncOwner = createMcpLifecycleLockOwner("async-reclaim", "async-reclaim-owner");
    const syncOwner = createMcpLifecycleLockOwner("sync-reclaim", "sync-reclaim-owner");
    fs.writeFileSync(asyncPath, `${JSON.stringify(asyncOwner)}\n`);
    fs.writeFileSync(syncPath, `${JSON.stringify(syncOwner)}\n`);
    const asyncObservation = await readMcpLifecycleLockObservation(asyncPath);
    const syncObservation = readMcpLifecycleLockObservationSync(syncPath);
    expect(asyncObservation).not.toBeNull();
    expect(syncObservation).not.toBeNull();

    await expect(
      reclaimStaleMcpLifecycleLockGeneration(asyncPath, asyncObservation!, () => {
        throw new Error("async assertion refused");
      }),
    ).rejects.toThrow("async assertion refused");
    expect(() =>
      reclaimStaleMcpLifecycleLockGenerationSync(syncPath, syncObservation!, () => {
        throw new Error("sync assertion refused");
      }),
    ).toThrow("sync assertion refused");
    expect(fs.existsSync(asyncPath)).toBe(true);
    expect(fs.existsSync(syncPath)).toBe(true);

    await expect(
      reclaimStaleMcpLifecycleLockGeneration(asyncPath, {
        ...asyncObservation!,
        owner: { ...asyncOwner, token: "different-async-owner" },
      }),
    ).resolves.toBe(false);
    expect(
      reclaimStaleMcpLifecycleLockGenerationSync(syncPath, {
        ...syncObservation!,
        owner: { ...syncOwner, token: "different-sync-owner" },
      }),
    ).toBe(false);
    await expect(
      reclaimStaleMcpLifecycleLockGeneration(`${asyncPath}.missing`, asyncObservation!),
    ).resolves.toBe(false);
    expect(
      reclaimStaleMcpLifecycleLockGenerationSync(`${syncPath}.missing`, syncObservation!),
    ).toBe(false);
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
