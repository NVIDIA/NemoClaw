// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpLifecycleLockOwner, type LockObservation } from "./mcp-lifecycle-lock-identity";
import {
  MAX_MCP_LIFECYCLE_LOCK_BYTES,
  readMcpLifecycleLockObservation,
  readMcpLifecycleLockObservationSync,
  reclaimStaleMcpLifecycleLockGeneration,
  reclaimStaleMcpLifecycleLockGenerationSync,
  safelyReleaseMcpLifecycleLock,
  safelyReleaseMcpLifecycleLockSync,
  writeMcpLifecycleLockCandidateAndLink,
  writeMcpLifecycleLockCandidateAndLinkSync,
} from "./mcp-lifecycle-lock-storage";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP lifecycle lock storage", () => {
  it("rejects an oversized asynchronous observation before reading its body", async () => {
    const lockPath = "/state/main.lock";
    const readFile = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(fs.promises, "open").mockResolvedValue({
      stat: vi.fn().mockResolvedValue({
        isFile: () => true,
        size: MAX_MCP_LIFECYCLE_LOCK_BYTES + 1,
      }),
      readFile,
      close,
    } as unknown as fs.promises.FileHandle);

    await expect(readMcpLifecycleLockObservation(lockPath)).rejects.toThrow(
      `Lock '${lockPath}' exceeds the ${String(MAX_MCP_LIFECYCLE_LOCK_BYTES)}-byte observation limit.`,
    );

    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("restores an oversized generation rejected after an asynchronous claim", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-storage-"));
    const lockPath = path.join(stateDir, "main.lock");
    try {
      fs.writeFileSync(lockPath, Buffer.alloc(MAX_MCP_LIFECYCLE_LOCK_BYTES + 1, "x"));
      const before = fs.statSync(lockPath);
      const expected: LockObservation = {
        owner: null,
        mtimeMs: before.mtimeMs,
        dev: before.dev,
        ino: before.ino,
        reclaimable: true,
      };

      await expect(reclaimStaleMcpLifecycleLockGeneration(lockPath, expected)).rejects.toThrow(
        `Lock '${lockPath}' exceeds the ${String(MAX_MCP_LIFECYCLE_LOCK_BYTES)}-byte observation limit.`,
      );

      const after = fs.statSync(lockPath);
      expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
        dev: before.dev,
        ino: before.ino,
        size: MAX_MCP_LIFECYCLE_LOCK_BYTES + 1,
      });
      expect(fs.readdirSync(stateDir)).toEqual(["main.lock"]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an oversized synchronous observation before reading its body", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-storage-"));
    const lockPath = path.join(stateDir, "main.lock");
    fs.writeFileSync(lockPath, Buffer.alloc(MAX_MCP_LIFECYCLE_LOCK_BYTES + 1, "x"));
    const readFile = vi.spyOn(fs, "readFileSync");
    try {
      expect(() => readMcpLifecycleLockObservationSync(lockPath)).toThrow(
        `Lock '${lockPath}' exceeds the ${String(MAX_MCP_LIFECYCLE_LOCK_BYTES)}-byte observation limit.`,
      );

      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("restores an oversized generation rejected after a synchronous claim", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-storage-"));
    const lockPath = path.join(stateDir, "main.lock");
    try {
      fs.writeFileSync(lockPath, Buffer.alloc(MAX_MCP_LIFECYCLE_LOCK_BYTES + 1, "x"));
      const before = fs.statSync(lockPath);
      const expected: LockObservation = {
        owner: null,
        mtimeMs: before.mtimeMs,
        dev: before.dev,
        ino: before.ino,
        reclaimable: true,
      };

      expect(() => reclaimStaleMcpLifecycleLockGenerationSync(lockPath, expected)).toThrow(
        `Lock '${lockPath}' exceeds the ${String(MAX_MCP_LIFECYCLE_LOCK_BYTES)}-byte observation limit.`,
      );

      const after = fs.statSync(lockPath);
      expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
        dev: before.dev,
        ino: before.ino,
        size: MAX_MCP_LIFECYCLE_LOCK_BYTES + 1,
      });
      expect(fs.readdirSync(stateDir)).toEqual(["main.lock"]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports and later recovers an async candidate without deleting a replacement lock", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-storage-"));
    const lockPath = path.join(stateDir, "main.lock");
    const owner = createMcpLifecycleLockOwner("alpha", "async-retained-candidate");
    const candidatePath = `${lockPath}.candidate-${String(process.pid)}-${owner.token}`;
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(new Error("candidate cleanup failed"));
    try {
      await expect(writeMcpLifecycleLockCandidateAndLink(lockPath, owner)).resolves.toBe(true);

      expect(warning).toHaveBeenCalledWith(expect.stringContaining(candidatePath), {
        code: "NEMOCLAW_MCP_LOCK_CANDIDATE_RETAINED",
      });
      expect(fs.existsSync(candidatePath)).toBe(true);
      fs.rmSync(lockPath);
      const replacement = createMcpLifecycleLockOwner("alpha", "async-replacement");
      fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`);

      await safelyReleaseMcpLifecycleLock(lockPath, owner.token);

      expect(fs.existsSync(candidatePath)).toBe(false);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
        token: replacement.token,
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports and later recovers a sync candidate without deleting a replacement lock", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-storage-"));
    const lockPath = path.join(stateDir, "main.lock");
    const owner = createMcpLifecycleLockOwner("alpha", "sync-retained-candidate");
    const candidatePath = `${lockPath}.candidate-${String(process.pid)}-${owner.token}`;
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("candidate cleanup failed");
    });
    try {
      expect(writeMcpLifecycleLockCandidateAndLinkSync(lockPath, owner)).toBe(true);

      expect(warning).toHaveBeenCalledWith(expect.stringContaining(candidatePath), {
        code: "NEMOCLAW_MCP_LOCK_CANDIDATE_RETAINED",
      });
      expect(fs.existsSync(candidatePath)).toBe(true);
      fs.rmSync(lockPath);
      const replacement = createMcpLifecycleLockOwner("alpha", "sync-replacement");
      fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`);

      safelyReleaseMcpLifecycleLockSync(lockPath, owner.token);

      expect(fs.existsSync(candidatePath)).toBe(false);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
        token: replacement.token,
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
