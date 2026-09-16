// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMcpLifecycleLockOwner, type LockObservation } from "./mcp-lifecycle-lock-identity";
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

describe("MCP lifecycle lock storage", () => {
  let stateDir: string;
  let lockPath: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-storage-"));
    lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("observes valid and malformed lock records through both APIs", async () => {
    const owner = createMcpLifecycleLockOwner("alpha", "valid-owner");
    fs.writeFileSync(lockPath, `${JSON.stringify(owner)}\n`);

    await expect(readMcpLifecycleLockObservation(lockPath)).resolves.toMatchObject({
      owner: { token: owner.token },
      reclaimable: true,
    });
    expect(readMcpLifecycleLockObservationSync(lockPath)).toMatchObject({
      owner: { token: owner.token },
      reclaimable: true,
    });

    fs.writeFileSync(lockPath, "not-json\n");
    await expect(readMcpLifecycleLockObservation(lockPath)).resolves.toMatchObject({
      owner: null,
      reclaimable: true,
    });
    expect(readMcpLifecycleLockObservationSync(lockPath)).toMatchObject({
      owner: null,
      reclaimable: true,
    });

    fs.writeFileSync(lockPath, "{}\n");
    await expect(readMcpLifecycleLockObservation(lockPath)).resolves.toMatchObject({
      owner: null,
      reclaimable: true,
    });
    expect(readMcpLifecycleLockObservationSync(lockPath)).toMatchObject({
      owner: null,
      reclaimable: true,
    });
  });

  it("reports missing paths through asynchronous and synchronous probes", async () => {
    await expect(readMcpLifecycleLockObservation(lockPath)).resolves.toBeNull();
    expect(readMcpLifecycleLockObservationSync(lockPath)).toBeNull();
    await expect(mcpLifecycleLockPathExists(lockPath)).resolves.toBe(false);
    expect(mcpLifecycleLockPathExistsSync(lockPath)).toBe(false);

    fs.writeFileSync(lockPath, "invalid\n");
    await expect(mcpLifecycleLockPathExists(lockPath)).resolves.toBe(true);
    expect(mcpLifecycleLockPathExistsSync(lockPath)).toBe(true);
  });

  it("classifies directories and symbolic links without following them", async () => {
    const directoryPath = path.join(stateDir, "directory.lock");
    const symlinkPath = path.join(stateDir, "symlink.lock");
    fs.mkdirSync(directoryPath);
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

  it("publishes and releases only the matching asynchronous owner", async () => {
    const owner = createMcpLifecycleLockOwner("alpha", "async-owner");

    await expect(writeMcpLifecycleLockCandidateAndLink(lockPath, owner)).resolves.toBe(true);
    await expect(writeMcpLifecycleLockCandidateAndLink(lockPath, owner)).resolves.toBe(false);

    await safelyReleaseMcpLifecycleLock(lockPath, "replacement-token");
    await expect(mcpLifecycleLockPathExists(lockPath)).resolves.toBe(true);

    await safelyReleaseMcpLifecycleLock(lockPath, owner.token);
    await expect(mcpLifecycleLockPathExists(lockPath)).resolves.toBe(false);
    await expect(safelyReleaseMcpLifecycleLock(lockPath, owner.token)).resolves.toBeUndefined();
  });

  it("publishes and releases only the matching synchronous owner", () => {
    const owner = createMcpLifecycleLockOwner("alpha", "sync-owner");

    expect(writeMcpLifecycleLockCandidateAndLinkSync(lockPath, owner)).toBe(true);
    expect(writeMcpLifecycleLockCandidateAndLinkSync(lockPath, owner)).toBe(false);

    safelyReleaseMcpLifecycleLockSync(lockPath, "replacement-token");
    expect(mcpLifecycleLockPathExistsSync(lockPath)).toBe(true);

    safelyReleaseMcpLifecycleLockSync(lockPath, owner.token);
    expect(mcpLifecycleLockPathExistsSync(lockPath)).toBe(false);
    expect(() => safelyReleaseMcpLifecycleLockSync(lockPath, owner.token)).not.toThrow();
  });

  it("reconciles successful publication when link replies are lost", async () => {
    const asyncOwner = createMcpLifecycleLockOwner("alpha", "async-lost-reply");
    const link = fs.promises.link.bind(fs.promises);
    const asyncLink = vi
      .spyOn(fs.promises, "link")
      .mockImplementationOnce(async (source, target) => {
        await link(source, target);
        throw Object.assign(new Error("lost link reply"), { code: "EIO" });
      });

    await expect(writeMcpLifecycleLockCandidateAndLink(lockPath, asyncOwner)).resolves.toBe(true);
    asyncLink.mockRestore();
    await safelyReleaseMcpLifecycleLock(lockPath, asyncOwner.token);

    const syncOwner = createMcpLifecycleLockOwner("alpha", "sync-lost-reply");
    const linkSync = fs.linkSync.bind(fs);
    const syncLink = vi.spyOn(fs, "linkSync").mockImplementationOnce((source, target) => {
      linkSync(source, target);
      throw Object.assign(new Error("lost link reply"), { code: "EIO" });
    });

    expect(writeMcpLifecycleLockCandidateAndLinkSync(lockPath, syncOwner)).toBe(true);
    syncLink.mockRestore();
    safelyReleaseMcpLifecycleLockSync(lockPath, syncOwner.token);
  });

  it("restores a claimed generation when its owner does not match", async () => {
    const owner = createMcpLifecycleLockOwner("alpha", "published-owner");
    const replacement = createMcpLifecycleLockOwner("alpha", "expected-owner");
    fs.writeFileSync(lockPath, `${JSON.stringify(owner)}\n`);
    const stat = fs.statSync(lockPath);
    const expected: LockObservation = {
      owner: replacement,
      mtimeMs: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
      reclaimable: true,
    };

    await expect(reclaimStaleMcpLifecycleLockGeneration(lockPath, expected)).resolves.toBe(false);
    await expect(readMcpLifecycleLockObservation(lockPath)).resolves.toMatchObject({
      owner: { token: owner.token },
    });

    expect(reclaimStaleMcpLifecycleLockGenerationSync(lockPath, expected)).toBe(false);
    expect(readMcpLifecycleLockObservationSync(lockPath)).toMatchObject({
      owner: { token: owner.token },
    });
  });

  it("reports a missing generation as an unsuccessful reclaim", async () => {
    const expected: LockObservation = {
      owner: null,
      mtimeMs: 0,
      dev: 0,
      ino: 0,
      reclaimable: true,
    };

    await expect(reclaimStaleMcpLifecycleLockGeneration(lockPath, expected)).resolves.toBe(false);
    expect(reclaimStaleMcpLifecycleLockGenerationSync(lockPath, expected)).toBe(false);
  });
});
