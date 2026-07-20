// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellSandboxControl } from "./adapters/openshell/sandbox-control";
import { shellQuote } from "./core/shell-quote";
import type { SkillPaths } from "./skill-install";

export { shellQuote };

export interface SandboxControlContext {
  control: OpenShellSandboxControl;
  sandboxName: string;
}

export interface SandboxCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type SandboxExecImpl = (
  ctx: SandboxControlContext,
  command: string,
  opts?: { input?: string | Buffer; timeout?: number },
) => Promise<SandboxCommandResult | null>;

/** Execute one shell command through the selected OpenShell control plane. */
export async function sandboxExec(
  ctx: SandboxControlContext,
  command: string,
  opts: { input?: string | Buffer; timeout?: number } = {},
): Promise<SandboxCommandResult | null> {
  try {
    const result = await ctx.control.exec({
      sandboxName: ctx.sandboxName,
      command: ["sh", "-lc", command],
      stdin: opts.input,
      timeoutMs: opts.timeout ?? 30_000,
    });
    return {
      status: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Check whether a skill directory already exists at the upload path or, for
 * OpenClaw, the mirror path. Directory probes let removal clean partial
 * uploads whose manifest write failed. A recognized sentinel from a
 * successful command maps to true or false. Transport errors, nonzero status,
 * and malformed output map to null so callers can fail before mutation.
 */
export async function checkExisting(
  ctx: SandboxControlContext,
  paths: SkillPaths,
  opts: { execImpl?: SandboxExecImpl } = {},
): Promise<boolean | null> {
  const checks = [`test -e ${shellQuote(paths.uploadDir)}`];
  if (paths.isOpenClaw && paths.mirrorDir) checks.push(`test -e "${paths.mirrorDir}"`);
  const result = await (opts.execImpl ?? sandboxExec)(
    ctx,
    `{ ${checks.join(" || ")}; } && echo EXISTS || echo ABSENT`,
  );
  if (result === null || result.status !== 0) return null;
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

/** Remove one named skill and clear OpenClaw's session index. */
export async function removeSkill(
  ctx: SandboxControlContext,
  paths: SkillPaths,
  opts: { execImpl?: SandboxExecImpl } = {},
): Promise<RemoveResult> {
  const messages: string[] = [];
  const run = opts.execImpl ?? sandboxExec;

  const removeUpload = await run(ctx, `rm -rf ${shellQuote(paths.uploadDir)}`);
  const removedUploadDir = removeUpload !== null && removeUpload.status === 0;
  if (!removedUploadDir) {
    messages.push(`Warning: failed to remove upload directory ${paths.uploadDir}`);
  }

  let removedMirrorDir = false;
  if (paths.isOpenClaw && paths.mirrorDir) {
    const removeMirror = await run(ctx, `rm -rf "${paths.mirrorDir}"`);
    removedMirrorDir = removeMirror !== null && removeMirror.status === 0;
    if (!removedMirrorDir) {
      messages.push(`Warning: failed to remove mirror directory ${paths.mirrorDir}`);
    }
  }

  let clearedSessions = false;
  if (paths.isOpenClaw && paths.sessionFile) {
    const clearResult = await run(ctx, `printf '{}' > ${shellQuote(paths.sessionFile)}`);
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

/** Verify that both managed skill directories are absent. */
export async function verifyRemove(
  ctx: SandboxControlContext,
  paths: SkillPaths,
  opts: { execImpl?: SandboxExecImpl } = {},
): Promise<boolean> {
  const checks = [`test ! -e ${shellQuote(paths.uploadDir)}`];
  if (paths.isOpenClaw && paths.mirrorDir) checks.push(`test ! -e "${paths.mirrorDir}"`);
  const result = await (opts.execImpl ?? sandboxExec)(
    ctx,
    `${checks.join(" && ")} && echo GONE || echo EXISTS`,
  );
  return result !== null && result.stdout === "GONE";
}
