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

export class ShareCommandError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n"));
    this.name = "ShareCommandError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

function shareFail(lines: string | readonly string[], exitCode = 1): never {
  throw new ShareCommandError(lines, exitCode);
}

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
 * Pre-flight: confirm the remote source path actually exists inside the
 * sandbox. sshfs exits non-zero with empty stderr when the remote path is
 * missing (e.g. a typo), and the bare "SSHFS mount failed." line we used to
 * emit left the user with nothing actionable. Returns normally when the path
 * can be verified; emits a structured error and exits the process non-zero
 * when it cannot. The success path has no return value.
 * Exported so the behavior is testable without driving the full sshfs
 * lifecycle. See #3414.
 */
export function assertSandboxPathExistsOrExit(
  deps: ShareCommandDeps,
  sandboxName: string,
  remotePath: string,
): void {
  if (deps.checkSandboxPathExists(sandboxName, remotePath)) return;
  // The probe returns false for both "path is missing" and "exec itself
  // failed" (transient gRPC, sandbox just restarted, etc.), so phrase the
  // headline as a verification failure rather than a definitive claim that
  // the path is missing.
  console.error(
    `  Could not verify sandbox path '${remotePath}' in sandbox '${sandboxName}' (missing path or probe failure).`,
  );
  console.error(
    `  Verify the path with: ${deps.cliName} ${sandboxName} connect, then ls ${remotePath}`,
  );
  console.error(`  The default is /sandbox; check for typos in any custom path you passed.`);
  process.exit(1);
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

/**
 * Verify that `localMount` exists and is writable so FUSE can mount onto it.
 * Creates the directory (recursive) if missing, and reports the specific
 * failure reason (read-only filesystem, permission denied, etc.) when the
 * mount target is unusable. Returning a structured result instead of
 * throwing keeps the helper unit-testable; the caller decides how to surface
 * the error to the user.
 */
export function checkLocalMountWritable(localMount: string): { writable: boolean; reason?: string } {
  try {
    // Node's fs.mkdirSync(path, { recursive: true }) masks EROFS as ENOENT when
    // the leaf is missing on a read-only parent (#4311). Use non-recursive mkdir
    // when the parent already exists so EROFS propagates with its true errno;
    // fall back to recursive only when the parent is genuinely missing.
    if (fs.existsSync(path.dirname(localMount))) {
      try {
        fs.mkdirSync(localMount);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw err;
        if (!fs.statSync(localMount).isDirectory()) {
          return { writable: false, reason: "mount target exists and is not a directory" };
        }
      }
    } else {
      fs.mkdirSync(localMount, { recursive: true });
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EROFS") return { writable: false, reason: "parent filesystem is read-only" };
    if (code === "EACCES") return { writable: false, reason: "permission denied creating the directory" };
    return { writable: false, reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    fs.accessSync(localMount, fs.constants.W_OK);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EROFS") return { writable: false, reason: "filesystem is read-only" };
    if (code === "EACCES") return { writable: false, reason: "directory is not writable" };
    return { writable: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { writable: true };
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
    shareFail([
      "  sshfs is not installed.",
      process.platform === "darwin"
        ? "  Install with: brew install macfuse && brew install sshfs"
        : "  Install with: sudo apt-get install sshfs  (or: sudo dnf install fuse-sshfs)",
    ]);
  }

  // Check not already mounted
  if (isMountPoint(localMount)) {
    shareFail([
      `  ${localMount} is already mounted.`,
      `  Run '${deps.cliName} ${sandboxName} share unmount' first.`,
    ]);
  }

  // Verify sandbox is running
  await deps.ensureLive(sandboxName);

  // Pre-flight: confirm the remote source path actually exists. See #3414.
  assertSandboxPathExistsOrExit(deps, sandboxName, remotePath);

  // Get SSH config
  const sshConfigResult = deps.getSshConfig(sandboxName);
  if (sshConfigResult.status !== 0) {
    shareFail("  Failed to obtain SSH configuration for the sandbox.");
  }

  // Use a private temp directory to prevent symlink attacks on predictable paths.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sshfs-"));
  const tmpFile = path.join(tmpDir, `${sandboxName}.conf`);
  fs.writeFileSync(tmpFile, sshConfigResult.output, { mode: 0o600, flag: "wx" });

  const writable = checkLocalMountWritable(localMount);
  if (!writable.writable) {
    console.error(`  Local mount path '${localMount}' is not usable: ${writable.reason}.`);
    console.error("  share mount projects sandbox files onto a host directory via SSHFS,");
    console.error("  so the local target must be on a writable filesystem.");
    console.error(
      `  Pick a writable directory: ${deps.cliName} ${sandboxName} share mount ${remotePath} <writable-path>`,
    );
    try {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    } catch {
      /* ignore */
    }
    process.exit(1);
  }

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
      mountFailed = true;
      const lines = ["  SSHFS mount failed."];
      if (stderr) lines.push(`  ${stderr}`);
      if (/sftp/i.test(stderr)) {
        lines.push("  The sandbox may lack openssh-sftp-server.");
        lines.push(
          `  If this sandbox uses the default base image, rebuild with: ${deps.cliName} ${sandboxName} rebuild --yes`,
        );
        lines.push(
          "  If it was created from a custom `--from` image, add openssh-sftp-server at /usr/lib/openssh/sftp-server and rebuild.",
        );
      }
      shareFail(lines);
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
  if (mountFailed) shareFail("  SSHFS mount failed.");
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
      shareFail([
        "  Could not find fusermount3 or fusermount on this host.",
        "  Install with: sudo apt-get install fuse3  (or: sudo dnf install fuse3)",
      ]);
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
      shareFail(`  ${localMount} is not currently mounted.`);
    }
    const lines = [`  Unmount failed: ${stderr || "unknown error"}`];
    if (process.platform !== "darwin") {
      lines.push(`  Try: ${unmountCmd} -uz ${localMount}`);
    }
    shareFail(lines);
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
  shareFail([
    `  Usage: ${cliName} <name> share <mount|unmount|status>`,
    "    mount   [sandbox-path] [local-mount-point]  Mount sandbox filesystem via SSHFS",
    "    unmount [local-mount-point]                 Unmount a previously mounted filesystem",
    "    status  [local-mount-point]                 Check current mount status",
  ], exitCode);
}
