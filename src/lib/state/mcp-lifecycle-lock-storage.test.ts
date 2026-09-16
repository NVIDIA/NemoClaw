// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpLifecycleLockOwner } from "./mcp-lifecycle-lock-identity";
import {
  readMcpLifecycleLockObservation,
  readMcpLifecycleLockObservationSync,
  reclaimStaleMcpLifecycleLockGeneration,
  reclaimStaleMcpLifecycleLockGenerationSync,
  writeMcpLifecycleLockCandidateAndLink,
  writeMcpLifecycleLockCandidateAndLinkSync,
} from "./mcp-lifecycle-lock-storage";

const owner = (token: string): McpLifecycleLockOwner => ({
  version: 1,
  sandboxName: "alpha",
  pid: process.pid,
  processIdentity: null,
  token,
  acquiredAt: "2026-09-16T00:00:00.000Z",
});

const variants = [
  {
    mode: "async",
    read: readMcpLifecycleLockObservation,
    reclaim: reclaimStaleMcpLifecycleLockGeneration,
    publish: writeMcpLifecycleLockCandidateAndLink,
  },
  {
    mode: "sync",
    read: readMcpLifecycleLockObservationSync,
    reclaim: reclaimStaleMcpLifecycleLockGenerationSync,
    publish: writeMcpLifecycleLockCandidateAndLinkSync,
  },
];

describe.each(variants)("$mode lock reclamation recovery", ({ read, reclaim, publish }) => {
  let root: string;
  let lockPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-storage-"));
    lockPath = path.join(root, "alpha.lock");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not trust a symlink target as the lock owner", async () => {
    const target = path.join(root, "target");
    const contents = JSON.stringify(owner("target-owner"));
    fs.writeFileSync(target, contents);
    fs.symlinkSync(target, lockPath);
    const link = fs.lstatSync(lockPath);

    expect(await read(lockPath)).toEqual({
      owner: null,
      mtimeMs: link.mtimeMs,
      dev: link.dev,
      ino: link.ino,
      reclaimable: true,
    });
    expect(fs.readFileSync(target, "utf8")).toBe(contents);
  });

  it("keeps directories out of the reclaimable lock classification", async () => {
    fs.mkdirSync(lockPath);

    expect(await read(lockPath)).toMatchObject({ owner: null, reclaimable: false });
    expect(fs.lstatSync(lockPath).isDirectory()).toBe(true);
  });

  it("restores the same owner inode when authorization fails after claiming it", async () => {
    await publish(lockPath, owner("original"));
    const expected = await read(lockPath);
    assert.ok(expected);

    await expect(async () =>
      reclaim(lockPath, expected, () => {
        throw new Error("authorization changed");
      }),
    ).rejects.toThrow("authorization changed");

    expect(await read(lockPath)).toEqual(expected);
    expect(fs.readdirSync(root)).toEqual(["alpha.lock"]);
  });

  it("removes the reclaimed generation after successful authorization", async () => {
    expect(await publish(lockPath, owner("stale"))).toBe(true);
    const expected = await read(lockPath);
    assert.ok(expected);

    expect(await reclaim(lockPath, expected)).toBe(true);

    expect(await read(lockPath)).toBeNull();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("preserves a replacement owner that appears after the stale observation", async () => {
    await publish(lockPath, owner("original"));
    const expected = await read(lockPath);
    assert.ok(expected);
    fs.unlinkSync(lockPath);
    await publish(lockPath, owner("replacement"));
    const replacement = await read(lockPath);

    expect(await reclaim(lockPath, expected)).toBe(false);

    expect(await read(lockPath)).toEqual(replacement);
    expect(fs.readdirSync(root)).toEqual(["alpha.lock"]);
  });

  it("retains both generations when another owner publishes during failed recovery", async () => {
    await publish(lockPath, owner("original"));
    const expected = await read(lockPath);
    assert.ok(expected);

    await expect(async () =>
      reclaim(lockPath, expected, () => {
        fs.writeFileSync(lockPath, JSON.stringify(owner("replacement")), { flag: "wx" });
        throw new Error("authorization changed");
      }),
    ).rejects.toThrow("authorization changed");

    expect((await read(lockPath))?.owner?.token).toBe("replacement");
    const retained = fs.readdirSync(root).filter((name) => name !== "alpha.lock");
    expect(retained).toHaveLength(1);
    expect(await read(path.join(root, retained[0]))).toEqual(expected);
  });

  it("does not mistake a different corrupt inode for the observed stale generation", async () => {
    fs.writeFileSync(lockPath, "corrupt original");
    const expected = await read(lockPath);
    assert.ok(expected);
    const replacementPath = path.join(root, "replacement");
    fs.writeFileSync(replacementPath, "corrupt replacement");
    fs.renameSync(replacementPath, lockPath);
    const replacement = await read(lockPath);

    expect(await reclaim(lockPath, expected)).toBe(false);

    expect(await read(lockPath)).toEqual(replacement);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("corrupt replacement");
    expect(fs.readdirSync(root)).toEqual(["alpha.lock"]);
  });
});
