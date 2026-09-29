// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildStoppedSandboxNativeHomeCleanupScript } from "./stopped-sandbox-state-cleanup";

describe("stopped native-home cleanup", () => {
  it("removes complete native state while preserving exact user-managed paths", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-native-cleanup-"));
    try {
      const root = path.join(fixture, "sandbox");
      const preserved = path.join(root, ".deepagents", ".env");
      const removedSibling = path.join(root, ".deepagents", "cache", "state.json");
      const removedWorkspace = path.join(root, "workspace", "memory.txt");
      fs.mkdirSync(path.dirname(preserved), { recursive: true });
      fs.mkdirSync(path.dirname(removedSibling), { recursive: true });
      fs.mkdirSync(path.dirname(removedWorkspace), { recursive: true });
      fs.writeFileSync(preserved, "USER_MANAGED=1\n");
      fs.writeFileSync(removedSibling, "sandbox state\n");
      fs.writeFileSync(removedWorkspace, "sandbox state\n");

      const result = spawnSync(
        process.execPath,
        ["-e", buildStoppedSandboxNativeHomeCleanupScript(), root, JSON.stringify([preserved])],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(preserved, "utf8")).toBe("USER_MANAGED=1\n");
      expect(fs.existsSync(removedSibling)).toBe(false);
      expect(fs.existsSync(removedWorkspace)).toBe(false);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("refuses a symlink in a protected path's ancestor chain", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-native-symlink-"));
    try {
      const root = path.join(fixture, "sandbox");
      const outside = path.join(fixture, "outside");
      const protectedPath = path.join(root, "project", "source");
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "keep.txt"), "outside\n");
      fs.symlinkSync(outside, path.join(root, "project"));

      const result = spawnSync(
        process.execPath,
        ["-e", buildStoppedSandboxNativeHomeCleanupScript(), root, JSON.stringify([protectedPath])],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(44);
      expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("outside\n");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
