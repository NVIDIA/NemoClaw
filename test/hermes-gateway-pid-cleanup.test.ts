// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Mocked shell-unit coverage for the Hermes gateway-PID-file cleanup contract.
// remove_stale_gateway_file() is the seam guarding the root-owned gateway.pid
// path: a stale regular file OR a symlink at the PID path must be removed
// (never symlink-followed) so the resulting gateway.pid is always a regular
// file, never a symlink. Previously this was only proven by the live
// test/e2e/live/hermes-root-entrypoint-smoke.test.ts legacy-migration case.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractShellFunctionFromSource(src: string, name: string): string {
  const escapedName = escapeRegExp(name);
  const match = src.match(new RegExp(`${escapedName}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in agents/hermes/start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

/**
 * Extract remove_stale_gateway_file and run it against `pidPath` inside a
 * throwaway temp dir. Returns the spawn result plus the temp root so callers
 * can assert on the resulting on-disk shape.
 */
function runRemoveStale(
  seed: (tmp: string, pidPath: string) => void,
  label = "legacy PID file",
): { status: number | null; stderr: string; tmp: string; pidPath: string } {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const fn = extractShellFunctionFromSource(src, "remove_stale_gateway_file");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-gw-pid-cleanup-"));
  const pidPath = path.join(tmp, "gateway.pid");
  seed(tmp, pidPath);

  const script = [
    "set -euo pipefail",
    fn,
    `remove_stale_gateway_file ${JSON.stringify(pidPath)} ${JSON.stringify(label)}`,
  ].join("\n");

  const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
  return { status: result.status, stderr: result.stderr, tmp, pidPath };
}

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
