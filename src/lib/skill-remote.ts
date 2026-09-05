// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { openshellSandboxSshHost } from "./adapters/openshell/sandbox-ssh-host";
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
        openshellSandboxSshHost(ctx.sandboxName),
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
 * path. Probing directories instead of only
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
  // Existence gate for `skill remove`. Shared agent destinations are probed
  // only for user-facing diagnostics; removeSkill() still refuses to mutate
  // them because their presence is not proof of NemoClaw ownership (#5753).
  const runSsh = opts.sshExecImpl ?? sshExec;
  const result = runSsh(
    ctx,
    `test -e ${shellQuote(paths.uploadDir)} && echo EXISTS || echo ABSENT`,
  );
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
  messages: string[];
}

/**
 * Remove a skill from the sandbox by name.
 * Deletes the generic agent upload directory.
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

  if (paths.isOpenClaw) {
    return {
      success: false,
      removedUploadDir: false,
      messages: ["Error: automatic OpenClaw workspace skill removal is unavailable."],
    };
  }

  if (paths.uploadDirSharedWithAgent) {
    return {
      success: false,
      removedUploadDir: false,
      messages: [
        `Error: automatic removal is unavailable for the agent-owned skill directory ${paths.uploadDir}.`,
      ],
    };
  }

  // Remove the generic upload directory.
  const uploadDir = shellQuote(paths.uploadDir);
  const removeUpload = runSsh(ctx, `rm -rf ${uploadDir}`);
  const removedUploadDir = removeUpload !== null && removeUpload.status === 0;
  if (!removedUploadDir) {
    messages.push(`Warning: failed to remove upload directory ${paths.uploadDir}`);
  }

  messages.push(
    paths.reloadsSkillsOnSessionStart
      ? "Start a new chat session for the removal to take effect; a gateway restart is not required."
      : "Restart the agent gateway for the removal to take effect.",
  );

  return {
    success: removedUploadDir,
    removedUploadDir,
    messages,
  };
}

/**
 * Verify the skill directory no longer exists on the sandbox.
 * OpenClaw and shared agent destinations have separate ownership contracts.
 */
export function verifyRemove(
  ctx: SshContext,
  paths: SkillPaths,
  opts: { sshExecImpl?: typeof sshExec } = {},
): boolean {
  if (paths.isOpenClaw || paths.uploadDirSharedWithAgent) return false;
  const runSsh = opts.sshExecImpl ?? sshExec;
  const result = runSsh(
    ctx,
    `test ! -e ${shellQuote(paths.uploadDir)} && echo GONE || echo EXISTS`,
  );
  return result !== null && result.stdout === "GONE";
}
