// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Mocked shell-unit coverage for the Hermes gateway-PID-file cleanup contract.
// remove_stale_gateway_file() is the seam guarding the root-owned gateway.pid
// path: a stale regular file OR a symlink at the PID path must be removed
// (never symlink-followed) so the resulting gateway.pid is always a regular
// file, never a symlink. Previously this was only proven by the live
// test/e2e/live/hermes-root-entrypoint-smoke.test.ts legacy-migration case.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runRemoveStale } from "./hermes-gateway-pid-cleanup-helpers.ts";

describe("Hermes remove_stale_gateway_file cleanup (legacy gateway.pid)", () => {
  it("removes a symlink at the PID path without following it, leaving no symlink target damage", () => {
    // A symlink pointing at a real target file must be removed itself; the
    // target must remain untouched (refuse to follow the link).
    let targetPath = "";
    const { status, stderr, tmp, pidPath } = runRemoveStale((tmpDir, pid) => {
      targetPath = path.join(tmpDir, "real-target");
      fs.writeFileSync(targetPath, "gateway target contents\n");
      fs.symlinkSync(targetPath, pid);
    });

    try {
      expect(status).toBe(0);
      expect(stderr).toContain("Removing unsafe stale Hermes legacy PID file symlink");
      // The symlink at the PID path is gone.
      expect(fs.existsSync(pidPath)).toBe(false);
      // The symlink was NOT followed: its target file is intact.
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.readFileSync(targetPath, "utf-8")).toBe("gateway target contents\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes a stale regular file at the PID path", () => {
    const { status, stderr, tmp, pidPath } = runRemoveStale((_tmpDir, pid) => {
      fs.writeFileSync(pid, "12345 987654\n");
    });

    try {
      expect(status).toBe(0);
      expect(stderr).toContain("Removing stale Hermes legacy PID file");
      expect(fs.existsSync(pidPath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when nothing exists at the PID path (fresh start)", () => {
    const { status, stderr, tmp, pidPath } = runRemoveStale(() => {
      // Seed nothing: pidPath does not exist.
    });

    try {
      expect(status).toBe(0);
      expect(stderr).not.toContain("Removing");
      expect(fs.existsSync(pidPath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes a dangling symlink (broken legacy link) so a regular file can replace it", () => {
    // A symlink whose target no longer exists is still unsafe at the root-owned
    // PID path; it must be removed so a later writer creates a regular file.
    const { status, stderr, tmp, pidPath } = runRemoveStale((tmpDir, pid) => {
      fs.symlinkSync(path.join(tmpDir, "does-not-exist"), pid);
    });

    try {
      expect(status).toBe(0);
      expect(stderr).toContain("Removing unsafe stale Hermes legacy PID file symlink");
      // lstat-based existence: the dangling symlink itself is gone.
      expect(fs.existsSync(pidPath)).toBe(false);
      let lstatFailed = false;
      try {
        fs.lstatSync(pidPath);
      } catch {
        lstatFailed = true;
      }
      expect(lstatFailed).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
