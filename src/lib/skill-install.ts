// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Skill install/remove logic for `nemoclaw <sandbox> skill install <path>`
// and `nemoclaw <sandbox> skill remove <name>`.
// Validates a local SKILL.md, uploads it to the sandbox via SSH, and
// performs agent-specific post-install steps (session refresh for
// OpenClaw). Non-OpenClaw agents get a "restart gateway" hint until a
// generic refresh contract is defined in the manifest schema.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// yaml is a production dependency (used by policies.ts, onboard.ts)
import YAML from "yaml";

import { isRecord } from "./core/json-types";

// ── Skill name validation ────────────────────────────────────────

/**
 * Validate that a skill name supplied on the CLI is safe to use as a remote path.
 * Rejects anything that isn't a valid skill name ([A-Za-z0-9._-]).
 */
export function validateSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}

// ── Frontmatter parsing ──────────────────────────────────────────

type FrontmatterScalar = string | number | boolean | null | undefined;
type FrontmatterValue = FrontmatterScalar | FrontmatterRecord | FrontmatterValue[];
type FrontmatterRecord = { [key: string]: FrontmatterValue };

export interface SkillFrontmatter {
  name: string;
  [key: string]: FrontmatterValue;
}

/**
 * Parse YAML frontmatter from a SKILL.md file content string.
 * Expects `---\n...\n---` delimiters at the top of the file.
 * Parses via the `yaml` library so malformed YAML is rejected.
 * Returns the parsed frontmatter with at least a `name` field.
 * Throws on missing delimiters, invalid YAML, missing `name`, or empty name.
 */
export function parseFrontmatter(content: string): SkillFrontmatter {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error("SKILL.md is missing YAML frontmatter (no opening --- delimiter)");
  }

  let closingIdx = lines.indexOf("---", 1);
  if (closingIdx === -1) {
    closingIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  }
  if (closingIdx === -1) {
    throw new Error("SKILL.md is missing closing --- frontmatter delimiter");
  }

  const fmRaw = lines.slice(1, closingIdx).join("\n");

  let parsed: FrontmatterValue;
  try {
    parsed = YAML.parse(fmRaw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SKILL.md frontmatter is not valid YAML: ${msg}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping (key: value pairs)");
  }

  const nameValue = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!nameValue) {
    throw new Error("SKILL.md frontmatter is missing required 'name' field");
  }

  if (!validateSkillName(nameValue)) {
    throw new Error(
      `SKILL.md name '${nameValue}' is invalid. Use [A-Za-z0-9._-] and do not use '.' or '..'.`,
    );
  }

  return { name: nameValue };
}

// ── Path resolution ──────────────────────────────────────────────

export interface SkillPaths {
  /** Upload target directory for the skill */
  uploadDir: string;
  /** OpenClaw-only mirror directory under the remote home dir, or null */
  mirrorDir: string | null;
  /** OpenClaw-only: session index to clear, or null */
  sessionFile: string | null;
  /** Whether the agent is OpenClaw (drives refresh behavior) */
  isOpenClaw: boolean;
}

/**
 * Resolve skill install paths from the agent definition.
 * Uses a single directory for skill uploads (no immutable/writable split).
 * @param agent - AgentDefinition from getSessionAgent(), or null for OpenClaw
 * @param skillName - validated skill name from frontmatter
 */
export function resolveSkillPaths(
  agent: { name: string; configPaths: { dir: string } } | null,
  skillName: string,
): SkillPaths {
  const isOpenClaw = !agent || agent.name === "openclaw";

  const dir = agent ? agent.configPaths.dir : "/sandbox/.openclaw";

  const uploadDir = `${dir}/skills/${skillName}`;

  return {
    uploadDir,
    mirrorDir: isOpenClaw ? `$HOME/.openclaw/skills/${skillName}` : null,
    sessionFile: isOpenClaw ? `${dir}/agents/main/sessions/sessions.json` : null,
    isOpenClaw,
  };
}

// ── Shell safety ─────────────────────────────────────────────────

// Re-export shellQuote from runner.ts — a repo-wide test enforces
// a single definition lives in runner.ts.
const { shellQuote } = require("./runner");

export { shellQuote };

const SAFE_PATH_RE = /^[A-Za-z0-9._\-/]+$/;

/**
 * Validate that a relative file path contains only safe characters.
 * Rejects shell metacharacters, spaces, backticks, $, quotes, etc.
 * Also rejects paths that escape the directory via `..`.
 */
export function validateRelativePath(rel: string): boolean {
  if (!rel || !SAFE_PATH_RE.test(rel)) return false;
  const segments = rel.split("/");
  return segments.every((s) => s !== "" && s !== ".." && s !== ".");
}

// ── SSH helpers ──────────────────────────────────────────────────

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
 * Upload a file to the sandbox by piping its content through SSH stdin.
 * Creates the target directory and writes the file in a single remote command.
 */
export function uploadFile(
  ctx: SshContext,
  localPath: string,
  remoteDir: string,
  remoteFilename: string,
): SshResult | null {
  const content = fs.readFileSync(localPath);
  const remotePath = `${remoteDir}/${remoteFilename}`;
  const script = `mkdir -p ${shellQuote(remoteDir)} && cat > ${shellQuote(remotePath)}`;
  return sshExec(ctx, script, { input: content });
}

export interface CollectedFiles {
  files: string[];
  skippedDotfiles: string[];
  unsafePaths: string[];
}

/**
 * Collect files under `dir` recursively, returning paths relative to `dir`.
 * Dotfiles (names starting with `.`) are excluded by default and reported
 * separately so the caller can warn. Paths with unsafe characters are
 * rejected to prevent shell injection when interpolated into SSH commands.
 */
export function collectFiles(dir: string): CollectedFiles {
  const files: string[] = [];
  const skippedDotfiles: string[] = [];
  const unsafePaths: string[] = [];

  function walk(current: string, prefix: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".")) {
        skippedDotfiles.push(entry.isDirectory() ? `${rel}/` : rel);
        continue;
      }
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), rel);
      } else if (entry.isFile()) {
        if (!validateRelativePath(rel)) {
          unsafePaths.push(rel);
        } else {
          files.push(rel);
        }
      }
    }
  }
  walk(dir, "");
  return { files, skippedDotfiles, unsafePaths };
}

/**
 * Upload an entire skill directory to the sandbox, preserving subdirectory
 * structure. Rejects files with unsafe path characters and skips dotfiles.
 */
export function uploadDirectory(
  ctx: SshContext,
  localDir: string,
  remoteDir: string,
): { uploaded: number; failed: string[]; skippedDotfiles: string[]; unsafePaths: string[] } {
  const { files, skippedDotfiles, unsafePaths } = collectFiles(localDir);
  if (unsafePaths.length > 0) {
    return { uploaded: 0, failed: unsafePaths, skippedDotfiles, unsafePaths };
  }
  const failed: string[] = [];
  for (const rel of files) {
    const localFile = path.join(localDir, rel);
    const remoteSubdir = rel.includes("/") ? `${remoteDir}/${path.dirname(rel)}` : remoteDir;
    const result = uploadFile(ctx, localFile, remoteSubdir, path.basename(rel));
    if (!result || result.status !== 0) {
      failed.push(rel);
    }
  }
  return { uploaded: files.length - failed.length, failed, skippedDotfiles, unsafePaths };
}

/**
 * Run post-install steps: session refresh for OpenClaw, or
 * non-OpenClaw restart hint.
 */
export function postInstall(
  ctx: SshContext,
  paths: SkillPaths,
  _localSkillDir: string,
  opts: {
    skipRefresh?: boolean;
    sshExecImpl?: typeof sshExec;
  } = {},
): { success: boolean; messages: string[] } {
  const messages: string[] = [];
  const runSsh = opts.sshExecImpl ?? sshExec;

  if (paths.isOpenClaw) {
    // Clear sessions.json so OpenClaw re-discovers skills on the next
    // session even after an in-place skill update.
    if (paths.sessionFile && !opts.skipRefresh) {
      const refreshResult = runSsh(ctx, `printf '{}' > ${shellQuote(paths.sessionFile)}`);
      if (!refreshResult || refreshResult.status !== 0) {
        messages.push("Warning: failed to clear sessions (agent may need manual restart)");
      }
    }
  } else {
    messages.push("Restart the agent gateway to pick up the new skill.");
  }

  return { success: true, messages };
}

/**
 * Check whether a skill already exists on the sandbox at the upload path
 * or (for OpenClaw) the mirror path. Probing both prevents a partial removal
 * (uploadDir gone, mirrorDir surviving) from blocking a reinstall.
 *
 * Returns:
 *   true  — skill exists
 *   false — skill is absent
 *   null  — SSH probe failed; existence could not be determined
 */
export function checkExisting(ctx: SshContext, paths: SkillPaths): boolean | null {
  const checks = [`test -f ${shellQuote(`${paths.uploadDir}/SKILL.md`)}`];
  if (paths.isOpenClaw && paths.mirrorDir) {
    checks.push(`test -f "${paths.mirrorDir}/SKILL.md"`);
  }
  const result = sshExec(ctx, `{ ${checks.join(" || ")}; } && echo EXISTS || echo ABSENT`);
  if (result === null || result.status !== 0) {
    return null;
  }
  if (result.stdout === "EXISTS") return true;
  if (result.stdout === "ABSENT") return false;
  return null;
}

/**
 * Verify the SKILL.md file exists on the sandbox at the expected path.
 */
export function verifyInstall(ctx: SshContext, paths: SkillPaths): boolean {
  const target = shellQuote(`${paths.uploadDir}/SKILL.md`);
  const result = sshExec(ctx, `test -f ${target} && echo EXISTS`);
  return result !== null && result.stdout === "EXISTS";
}

// ── Skill removal ────────────────────────────────────────────────

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
export function removeSkill(ctx: SshContext, paths: SkillPaths): RemoveResult {
  const messages: string[] = [];

  // 1. Remove the immutable upload directory (/sandbox/.openclaw/skills/<name>/)
  const uploadDir = shellQuote(paths.uploadDir);
  const removeUpload = sshExec(ctx, `rm -rf ${uploadDir}`);
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
    const removeMirror = sshExec(ctx, `rm -rf "${paths.mirrorDir}"`);
    removedMirrorDir = removeMirror !== null && removeMirror.status === 0;
    if (!removedMirrorDir) {
      messages.push(`Warning: failed to remove mirror directory ${paths.mirrorDir}`);
    }
  }

  // 3. Clear sessions.json so the agent re-discovers the remaining skills.
  let clearedSessions = false;
  if (paths.isOpenClaw && paths.sessionFile) {
    const clearResult = sshExec(ctx, `printf '{}' > ${shellQuote(paths.sessionFile)}`);
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
export function verifyRemove(ctx: SshContext, paths: SkillPaths): boolean {
  const checks = [`test ! -e ${shellQuote(paths.uploadDir)}`];
  if (paths.isOpenClaw && paths.mirrorDir) {
    checks.push(`test ! -e "${paths.mirrorDir}"`);
  }
  const result = sshExec(ctx, `${checks.join(" && ")} && echo GONE || echo EXISTS`);
  return result !== null && result.stdout === "GONE";
}
