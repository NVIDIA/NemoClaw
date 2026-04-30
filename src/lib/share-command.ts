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
import path from "path";
import fs from "fs";
import os from "os";

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
function resolveLinuxUnmount(): string | null {
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

// ── Dependencies (injected by nemoclaw.ts) ──────────────────────

export interface ShareCommandDeps {
  /** Run `openshell sandbox ssh-config <name>` and return output. */
  getSshConfig: (sandboxName: string) => { status: number; output: string };
  /** Ensure the sandbox is live, exit process if not. */
  ensureLive: (sandboxName: string) => Promise<void>;
  /** NVIDIA-green ANSI code (empty string if color disabled). */
  colorGreen: string;
  /** ANSI reset code (empty string if color disabled). */
  colorReset: string;
}

// ── Command handler ─────────────────────────────────────────────

export async function runShareCommand(
  sandboxName: string,
  subArgs: string[],
  deps: ShareCommandDeps,
): Promise<number> {
  const G = deps.colorGreen;
  const R = deps.colorReset;
  const subcommand = subArgs[0] || "help";

  switch (subcommand) {
    case "mount": {
      const remotePath = subArgs[1] || "/sandbox";
      const localMount = subArgs[2] || defaultShareMountDir(sandboxName);

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
          console.error(
            "  Install with: sudo apt-get install sshfs  (or: sudo dnf install fuse-sshfs)",
          );
        }
        return 1;
      }

      // Check not already mounted
      if (isMountPoint(localMount)) {
        console.error(`  ${localMount} is already mounted.`);
        console.error(`  Run 'nemoclaw ${sandboxName} share unmount' first.`);
        return 1;
      }

      // Verify sandbox is running
      await deps.ensureLive(sandboxName);

      // Get SSH config
      const sshConfigResult = deps.getSshConfig(sandboxName);
      if (sshConfigResult.status !== 0) {
        console.error("  Failed to obtain SSH configuration for the sandbox.");
        return 1;
      }

      const tmpFile = path.join(
        os.tmpdir(),
        `nemoclaw-sshfs-${sandboxName}-${process.pid}.conf`,
      );
      fs.writeFileSync(tmpFile, sshConfigResult.output, { mode: 0o600 });

      fs.mkdirSync(localMount, { recursive: true });

      try {
        const result = spawnSync(
          "sshfs",
          [
            "-F", tmpFile,
            "-o", "sftp_server=/usr/lib/openssh/sftp-server",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "reconnect",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
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
              `  If this sandbox uses the default base image, rebuild with: nemoclaw ${sandboxName} rebuild --yes`,
            );
            console.error(
              "  If it was created from a custom `--from` image, add openssh-sftp-server at /usr/lib/openssh/sftp-server and rebuild.",
            );
          }
          return 1;
        }
        console.log(`  ${G}\u2713${R} Mounted ${remotePath} \u2192 ${localMount}`);
        console.log(`  Edit files at ${localMount} \u2014 changes appear in the sandbox instantly.`);
      } finally {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }
      return 0;
    }

    case "unmount": {
      const localMount = subArgs[1] || defaultShareMountDir(sandboxName);

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
          return 1;
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
        return 1;
      }
      console.log(`  ${G}\u2713${R} Unmounted ${localMount}`);
      return 0;
    }

    case "status": {
      const localMount = subArgs[1] || defaultShareMountDir(sandboxName);
      if (isMountPoint(localMount)) {
        console.log(`  ${G}\u25cf${R} Mounted at ${localMount}`);
      } else {
        console.log(`  \u25cb Not mounted (expected at ${localMount})`);
      }
      return 0;
    }

    default:
      console.error("  Usage: nemoclaw <name> share <mount|unmount|status>");
      console.error(
        "    mount   [sandbox-path] [local-mount-point]  Mount sandbox filesystem via SSHFS",
      );
      console.error(
        "    unmount [local-mount-point]                 Unmount a previously mounted filesystem",
      );
      console.error(
        "    status  [local-mount-point]                 Check current mount status",
      );
      return 1;
  }
}
