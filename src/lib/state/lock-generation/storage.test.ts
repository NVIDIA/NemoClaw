// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { reclaimLockFileGeneration, reclaimLockFileGenerationSync } from "./storage";

function readFileSnapshot(filePath: string): string {
  const descriptor = fs.openSync(filePath, "r");
  try {
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

describe("lock file generation storage", () => {
  it("restores a replacement raced into an exact generation claim", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-generation-"));
    const lockPath = path.join(stateDir, "main.lock");
    fs.writeFileSync(lockPath, "stale");
    const expected = { ...fs.statSync(lockPath), reclaimable: true };
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(((from, to) => {
      const stalePath = `${String(from)}.stale`;
      originalRename(from, stalePath);
      fs.writeFileSync(from, "replacement");
      originalRename(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(reclaimLockFileGenerationSync(lockPath, expected)).toBe(false);
      expect(readFileSnapshot(lockPath)).toBe("replacement");
      expect(fs.readdirSync(stateDir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
    } finally {
      rename.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("removes an asynchronous quarantine after a replacement wins restoration", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-generation-"));
    const lockPath = path.join(stateDir, "main.lock");
    fs.writeFileSync(lockPath, "stale");
    const expected = { ...fs.statSync(lockPath), reclaimable: true };
    try {
      await expect(
        reclaimLockFileGeneration(lockPath, expected, {
          assertAfterClaim: () => {
            fs.writeFileSync(lockPath, "replacement");
            throw new Error("abort reclaim");
          },
        }),
      ).rejects.toThrow("abort reclaim");
      expect(readFileSnapshot(lockPath)).toBe("replacement");
      expect(fs.readdirSync(stateDir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("removes a synchronous quarantine after a replacement wins restoration", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-generation-"));
    const lockPath = path.join(stateDir, "main.lock");
    fs.writeFileSync(lockPath, "stale");
    const expected = { ...fs.statSync(lockPath), reclaimable: true };
    try {
      expect(() =>
        reclaimLockFileGenerationSync(lockPath, expected, {
          assertAfterClaim: () => {
            fs.writeFileSync(lockPath, "replacement");
            throw new Error("abort reclaim");
          },
        }),
      ).toThrow("abort reclaim");
      expect(readFileSnapshot(lockPath)).toBe("replacement");
      expect(fs.readdirSync(stateDir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("restores the claimed generation when synchronous removal fails", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-generation-"));
    const lockPath = path.join(stateDir, "main.lock");
    fs.writeFileSync(lockPath, "stale");
    const expected = { ...fs.statSync(lockPath), reclaimable: true };
    const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("injected removal failure");
    });
    try {
      expect(() => reclaimLockFileGenerationSync(lockPath, expected)).toThrow(
        /injected removal failure.*restored/u,
      );
      expect(readFileSnapshot(lockPath)).toBe("stale");
      expect(fs.readdirSync(stateDir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
    } finally {
      remove.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves a replacement when claimed-generation removal fails", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-generation-"));
    const lockPath = path.join(stateDir, "main.lock");
    fs.writeFileSync(lockPath, "stale");
    const expected = { ...fs.statSync(lockPath), reclaimable: true };
    const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("injected removal failure");
    });
    try {
      expect(() =>
        reclaimLockFileGenerationSync(lockPath, expected, {
          assertAfterClaim: () => fs.writeFileSync(lockPath, "replacement"),
        }),
      ).toThrow(/injected removal failure.*replacement.*preserved/u);
      expect(readFileSnapshot(lockPath)).toBe("replacement");
      expect(fs.readdirSync(stateDir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
    } finally {
      remove.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports a retained asynchronous quarantine when removal keeps failing", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-generation-"));
    const lockPath = path.join(stateDir, "main.lock");
    fs.writeFileSync(lockPath, "stale");
    const expected = { ...fs.statSync(lockPath), reclaimable: true };
    const originalRemove = fs.promises.rm.bind(fs.promises);
    const remove = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation((candidate, options) =>
        String(candidate).includes(".reclaim-")
          ? Promise.reject(new Error("persistent removal failure"))
          : originalRemove(candidate, options),
      );
    try {
      let message = "";
      try {
        await reclaimLockFileGeneration(lockPath, expected);
      } catch (error) {
        message = String(error);
      }
      const retained = fs.readdirSync(stateDir).find((name) => name.includes(".reclaim-"));
      expect(retained).toBeDefined();
      expect(message).toContain(path.join(stateDir, retained!));
      expect(message).toContain("verify that it is inactive before removing only that path");
      expect(readFileSnapshot(lockPath)).toBe("stale");
    } finally {
      remove.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
