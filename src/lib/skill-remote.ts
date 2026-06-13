// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { shellQuote } from "./core/shell-quote";
import type { SkillPaths } from "./skill-install";

export { shellQuote };

export interface SshContext {
  configFile: string;
  sandboxName: string;
}

export interface SshResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command on the sandbox via SSH with optional stdin content.
 * Uses the same SSH flags as executeSandboxCommand in sandbox-process-recovery-action.ts.
 */
export function sshExec(
  ctx: SshContext,
  command: string,
  opts: { input?: string | Buffer; timeout?: number } = {},
): SshResult | null {
  try {
    const result = spawnSync(
      "ssh",
      [
        "-F",
        ctx.configFile,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "LogLevel=ERROR",
        `openshell-${ctx.sandboxName}`,
        command,
      ],
      {
        encoding: "utf-8",
        stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        input: opts.input,
        timeout: opts.timeout ?? 30_000,
      },
    );
    return {
      status: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Check whether a skill directory already exists on the sandbox at the upload
 * path or (for OpenClaw) the mirror path. Probing directories instead of only
 * SKILL.md lets `skill remove` clean up partial uploads whose manifest write
 * failed after the directory was created.
 *
 * Returns:
 *   true  — skill exists
 *   false — skill is absent
 *   null  — SSH probe failed; existence could not be determined
 */
export function checkExisting(
  ctx: SshContext,
  paths: SkillPaths,
  opts: { sshExecImpl?: typeof sshExec } = {},
): boolean | null {
  const checks = [`test -e ${shellQuote(paths.uploadDir)}`];
  if (paths.isOpenClaw && paths.mirrorDir) {
    checks.push(`test -e "${paths.mirrorDir}"`);
  }
  const runSsh = opts.sshExecImpl ?? sshExec;
  const result = runSsh(ctx, `{ ${checks.join(" || ")}; } && echo EXISTS || echo ABSENT`);
  if (result === null || result.status !== 0) {
    return null;
  }
  if (result.stdout === "EXISTS") return true;
  if (result.stdout === "ABSENT") return false;
  return null;
}

export interface RemoveResult {
  success: boolean;
  removedUploadDir: boolean;
  removedMirrorDir: boolean;
  clearedSessions: boolean;
  messages: string[];
}

/**
 * Remove a skill from the sandbox by name.
 * Deletes the immutable upload directory, the OpenClaw mirror directory
 * (if applicable), and clears sessions.json so the agent re-discovers
 * the remaining skills on the next session.
 *
 * Only the named skill directory is deleted — other skills are untouched.
 */
export function removeSkill(
  ctx: SshContext,
  paths: SkillPaths,
  opts: { sshExecImpl?: typeof sshExec } = {},
): RemoveResult {
  const messages: string[] = [];
  const runSsh = opts.sshExecImpl ?? sshExec;

  // 1. Remove the immutable upload directory (/sandbox/.openclaw/skills/<name>/)
  const uploadDir = shellQuote(paths.uploadDir);
  const removeUpload = runSsh(ctx, `rm -rf ${uploadDir}`);
  const removedUploadDir = removeUpload !== null && removeUpload.status === 0;
  if (!removedUploadDir) {
    messages.push(`Warning: failed to remove upload directory ${paths.uploadDir}`);
  }

  // 2. Remove the OpenClaw mirror ($HOME/.openclaw/skills/<name>/)
  //    mirrorDir contains $HOME which must expand on the remote shell, so we
  //    use double quotes (not shellQuote). This is safe because skill names
  //    are restricted to [A-Za-z0-9._-] by parseFrontmatter / the name
  //    validation regex, so $HOME expansion is the only variable substitution.
  let removedMirrorDir = false;
  if (paths.isOpenClaw && paths.mirrorDir) {
    const removeMirror = runSsh(ctx, `rm -rf "${paths.mirrorDir}"`);
    removedMirrorDir = removeMirror !== null && removeMirror.status === 0;
    if (!removedMirrorDir) {
      messages.push(`Warning: failed to remove mirror directory ${paths.mirrorDir}`);
    }
  }

  // 3. Clear sessions.json so the agent re-discovers the remaining skills.
  let clearedSessions = false;
  if (paths.isOpenClaw && paths.sessionFile) {
    const clearResult = runSsh(ctx, `printf '{}' > ${shellQuote(paths.sessionFile)}`);
    clearedSessions = clearResult !== null && clearResult.status === 0;
    if (!clearedSessions) {
      messages.push("Warning: failed to clear sessions (agent may need manual restart)");
    }
  } else if (!paths.isOpenClaw) {
    messages.push("Restart the agent gateway for the removal to take effect.");
  }

  return {
    success: removedUploadDir && (!paths.isOpenClaw || removedMirrorDir),
    removedUploadDir,
    removedMirrorDir,
    clearedSessions,
    messages,
  };
}

/**
 * Verify the skill directory no longer exists on the sandbox.
 * For OpenClaw sandboxes, both the upload dir and the mirror dir must be gone.
 */
export function verifyRemove(
  ctx: SshContext,
  paths: SkillPaths,
  opts: { sshExecImpl?: typeof sshExec } = {},
): boolean {
  const checks = [`test ! -e ${shellQuote(paths.uploadDir)}`];
  if (paths.isOpenClaw && paths.mirrorDir) {
    checks.push(`test ! -e "${paths.mirrorDir}"`);
  }
  const runSsh = opts.sshExecImpl ?? sshExec;
  const result = runSsh(ctx, `${checks.join(" && ")} && echo GONE || echo EXISTS`);
  return result !== null && result.stdout === "GONE";
}
