// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { reclaimLockFileGenerationSync } from "./storage";

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
      expect(fs.readFileSync(lockPath, "utf8")).toBe("replacement");
      expect(fs.readdirSync(stateDir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
    } finally {
      rename.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
