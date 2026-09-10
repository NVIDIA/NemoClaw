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
