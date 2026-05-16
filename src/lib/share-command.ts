// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `nemoclaw <name> share mount|unmount|status` — SSHFS-based sandbox file sharing.
 *
 * Mounts the sandbox filesystem on the host via SSHFS, tunneled through
 * OpenShell's existing SSH proxy. Requires `sshfs` on the host and
 * `openssh-sftp-server` in the sandbox image.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { buildShareCommandDeps } from "./share-command-deps";
import type { ShareCommandDeps } from "./share-command-deps";

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Check whether a path is an active mount point.
 * Uses `mountpoint -q` on Linux (reliable), falls back to parsing
 * `mount` output on macOS or when mountpoint is unavailable.
 */
export function isMountPoint(dir: string): boolean {
  const resolved = path.resolve(dir);
  if (process.platform !== "darwin") {
    const mp = spawnSync("mountpoint", ["-q", resolved], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (mp.status === 0) return true;
    if (mp.status === 1) return false;
  }
  const result = spawnSync("mount", [], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return false;
  const escaped = resolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(` on ${escaped}(?: |$)`);
  return pattern.test(result.stdout || "");
}

export function defaultShareMountDir(sandboxName: string): string {
  return path.join(process.env.HOME || os.homedir(), ".nemoclaw", "mounts", sandboxName);
}

/**
 * Resolve the fusermount binary for Linux. FUSE 3 ships `fusermount3`;
 * older FUSE 2 ships `fusermount`. Probe both, preferring v3.
 */
export function resolveLinuxUnmount(): string | null {
  for (const cmd of ["fusermount3", "fusermount"]) {
    const probe = spawnSync("sh", ["-c", `command -v ${cmd}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (probe.status === 0 && (probe.stdout || "").trim()) {
      return (probe.stdout || "").trim();
    }
  }
  return null;
}

export type ShareMountOptions = {
  sandboxName: string;
  remotePath?: string;
  localMount?: string;
};

export type ShareUnmountOptions = {
  sandboxName: string;
  localMount?: string;
};

export type ShareStatusOptions = {
  sandboxName: string;
  localMount?: string;
};

export async function runShareMount(
  options: ShareMountOptions,
  deps: ShareCommandDeps = buildShareCommandDeps(),
): Promise<void> {
  const { sandboxName } = options;
  const remotePath = options.remotePath || "/sandbox";
  const localMount = options.localMount || defaultShareMountDir(sandboxName);
  const G = deps.colorGreen;
  const R = deps.colorReset;

  // Preflight: check sshfs binary
  const sshfsCheck = spawnSync("sh", ["-c", "command -v sshfs"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (sshfsCheck.status !== 0) {
    console.error("  sshfs is not installed.");
    if (process.platform === "darwin") {
      console.error("  Install with: brew install macfuse && brew install sshfs");
    } else {
      console.error("  Install with: sudo apt-get install sshfs  (or: sudo dnf install fuse-sshfs)");
    }
    process.exit(1);
  }

  // Check not already mounted
  if (isMountPoint(localMount)) {
    console.error(`  ${localMount} is already mounted.`);
    console.error(`  Run '${deps.cliName} ${sandboxName} share unmount' first.`);
    process.exit(1);
  }

  // Verify sandbox is running
  await deps.ensureLive(sandboxName);

  // Get SSH config
  const sshConfigResult = deps.getSshConfig(sandboxName);
  if (sshConfigResult.status !== 0) {
    console.error("  Failed to obtain SSH configuration for the sandbox.");
    process.exit(1);
  }

  // Use a private temp directory to prevent symlink attacks on predictable paths.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sshfs-"));
  const tmpFile = path.join(tmpDir, `${sandboxName}.conf`);
  fs.writeFileSync(tmpFile, sshConfigResult.output, { mode: 0o600, flag: "wx" });
  fs.mkdirSync(localMount, { recursive: true });

  let mountFailed = false;
  try {
    const result = spawnSync(
      "sshfs",
      [
        "-F",
        tmpFile,
        "-o",
        "sftp_server=/usr/lib/openssh/sftp-server",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "reconnect",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        `openshell-${sandboxName}:${remotePath}`,
        localMount,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
    );
    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      console.error("  SSHFS mount failed.");
      if (stderr) console.error(`  ${stderr}`);
      if (/sftp/i.test(stderr)) {
        console.error("  The sandbox may lack openssh-sftp-server.");
        console.error(
          `  If this sandbox uses the default base image, rebuild with: ${deps.cliName} ${sandboxName} rebuild --yes`,
        );
        console.error(
          "  If it was created from a custom `--from` image, add openssh-sftp-server at /usr/lib/openssh/sftp-server and rebuild.",
        );
      }
      mountFailed = true;
    } else {
      console.log(`  ${G}✓${R} Mounted ${remotePath} → ${localMount}`);
      console.log(`  Edit files at ${localMount} — changes appear in the sandbox instantly.`);
    }
  } finally {
    try {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    } catch {
      /* ignore */
    }
  }
  if (mountFailed) process.exit(1);
}

export function runShareUnmount(
  options: ShareUnmountOptions,
  deps: ShareCommandDeps = buildShareCommandDeps(),
): void {
  const { sandboxName } = options;
  const localMount = options.localMount || defaultShareMountDir(sandboxName);
  const G = deps.colorGreen;
  const R = deps.colorReset;

  let unmountCmd: string;
  let unmountArgs: string[];
  if (process.platform === "darwin") {
    unmountCmd = "umount";
    unmountArgs = [localMount];
  } else {
    const resolved = resolveLinuxUnmount();
    if (!resolved) {
      console.error("  Could not find fusermount3 or fusermount on this host.");
      console.error("  Install with: sudo apt-get install fuse3  (or: sudo dnf install fuse3)");
      process.exit(1);
      return;
    }
    unmountCmd = resolved;
    unmountArgs = ["-u", localMount];
  }

  const result = spawnSync(unmountCmd, unmountArgs, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    if (/not mounted|not found|no mount/i.test(stderr)) {
      console.error(`  ${localMount} is not currently mounted.`);
    } else {
      console.error(`  Unmount failed: ${stderr || "unknown error"}`);
      if (process.platform !== "darwin") {
        console.error(`  Try: ${unmountCmd} -uz ${localMount}`);
      }
    }
    process.exit(1);
  }
  console.log(`  ${G}✓${R} Unmounted ${localMount}`);
}

export function runShareStatus(
  options: ShareStatusOptions,
  deps: ShareCommandDeps = buildShareCommandDeps(),
): void {
  const { sandboxName } = options;
  const localMount = options.localMount || defaultShareMountDir(sandboxName);
  const G = deps.colorGreen;
  const R = deps.colorReset;
  if (isMountPoint(localMount)) {
    console.log(`  ${G}●${R} Mounted at ${localMount}`);
  } else {
    console.log(`  ○ Not mounted (expected at ${localMount})`);
  }
}

export function printShareUsageAndExit(exitCode = 1): never {
  const { cliName } = buildShareCommandDeps();
  console.error(`  Usage: ${cliName} <name> share <mount|unmount|status>`);
  console.error("    mount   [sandbox-path] [local-mount-point]  Mount sandbox filesystem via SSHFS");
  console.error("    unmount [local-mount-point]                 Unmount a previously mounted filesystem");
  console.error("    status  [local-mount-point]                 Check current mount status");
  process.exit(exitCode);
}
