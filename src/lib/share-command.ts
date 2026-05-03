// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `nemoclaw <name> share mount|unmount|status` — SSHFS-based sandbox file sharing.
 *
 * Mounts the sandbox filesystem on the host via SSHFS, tunneled through
 * OpenShell's existing SSH proxy. Requires `sshfs` on the host and
 * `openssh-sftp-server` in the sandbox image.
 */

import { Command, Args } from "@oclif/core";
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

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

// ── Oclif Command ───────────────────────────────────────────────

export default class ShareCommand extends Command {
  static id = "share";
  static strict = false;
  static summary = "Mount/unmount sandbox filesystem on the host via SSHFS";
  static description =
    "Share files between host and sandbox using SSHFS over OpenShell's SSH proxy.";
  static usage = [
    "share <sandbox-name> mount [sandbox-path] [local-mount-point]",
    "share <sandbox-name> unmount [local-mount-point]",
    "share <sandbox-name> status [local-mount-point]",
  ];
  static args = {
    sandboxName: Args.string({ required: true, description: "Sandbox name" }),
    subcommand: Args.string({
      required: false,
      description: "Action: mount, unmount, or status",
    }),
  };

  public async run(): Promise<void> {
    const { args, argv } = await this.parse(ShareCommand);
    const sandboxName = args.sandboxName;
    // argv contains all positional args including sandboxName and subcommand
    // plus any extra args (remotePath, localMount) that oclif doesn't parse
    // because strict=false. Strip sandboxName and subcommand to get the rest.
    const rawArgv = argv as string[];
    const subcommand = args.subcommand || "help";
    const extraArgs = rawArgv.slice(2); // skip sandboxName + subcommand

    const deps = buildShareCommandDeps();
    const G = deps.colorGreen;
    const R = deps.colorReset;

    switch (subcommand) {
      case "mount":
        await this.mount(sandboxName, extraArgs, deps, G, R);
        break;
      case "unmount":
        this.unmount(sandboxName, extraArgs, G, R);
        break;
      case "status":
        this.status(sandboxName, extraArgs, G, R);
        break;
      default:
        this.shareHelp();
    }
  }

  private async mount(
    sandboxName: string,
    extraArgs: string[],
    deps: ShareCommandDeps,
    G: string,
    R: string,
  ): Promise<void> {
    const remotePath = extraArgs[0] || "/sandbox";
    const localMount = extraArgs[1] || defaultShareMountDir(sandboxName);

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
            `  If this sandbox uses the default base image, rebuild with: ${deps.cliName} ${sandboxName} rebuild --yes`,
          );
          console.error(
            "  If it was created from a custom `--from` image, add openssh-sftp-server at /usr/lib/openssh/sftp-server and rebuild.",
          );
        }
        mountFailed = true;
      } else {
        console.log(`  ${G}\u2713${R} Mounted ${remotePath} \u2192 ${localMount}`);
        console.log(`  Edit files at ${localMount} \u2014 changes appear in the sandbox instantly.`);
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

  private unmount(sandboxName: string, extraArgs: string[], G: string, R: string): void {
    const localMount = extraArgs[0] || defaultShareMountDir(sandboxName);

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
    console.log(`  ${G}\u2713${R} Unmounted ${localMount}`);
  }

  private status(sandboxName: string, extraArgs: string[], G: string, R: string): void {
    const localMount = extraArgs[0] || defaultShareMountDir(sandboxName);
    if (isMountPoint(localMount)) {
      console.log(`  ${G}\u25cf${R} Mounted at ${localMount}`);
    } else {
      console.log(`  \u25cb Not mounted (expected at ${localMount})`);
    }
  }

  private shareHelp(): void {
    const { cliName } = buildShareCommandDeps();
    console.error(`  Usage: ${cliName} <name> share <mount|unmount|status>`);

    console.error(
      "    mount   [sandbox-path] [local-mount-point]  Mount sandbox filesystem via SSHFS",
    );
    console.error(
      "    unmount [local-mount-point]                 Unmount a previously mounted filesystem",
    );
    console.error(
      "    status  [local-mount-point]                 Check current mount status",
    );
    process.exit(1);
  }
}
