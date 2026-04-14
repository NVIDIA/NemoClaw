// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Skill install logic for `nemoclaw <sandbox> skill install <path>`.
// Validates a local SKILL.md, uploads it to the sandbox via SSH, and
// performs agent-specific post-install steps (OpenClaw mirror + session
// refresh). Non-OpenClaw agents get a "restart gateway" hint until a
// generic refresh contract is defined in the manifest schema.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// yaml is a production dependency (used by policies.ts, onboard.ts)
import YAML from "yaml";

// ── Frontmatter parsing ──────────────────────────────────────────

export interface SkillFrontmatter {
  name: string;
  [key: string]: unknown;
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

  let parsed: unknown;
  try {
    parsed = YAML.parse(fmRaw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SKILL.md frontmatter is not valid YAML: ${msg}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping (key: value pairs)");
  }

  const fm = parsed as Record<string, unknown>;
  const nameValue = typeof fm.name === "string" ? fm.name.trim() : "";
  if (!nameValue) {
    throw new Error("SKILL.md frontmatter is missing required 'name' field");
  }

  if (!/^[A-Za-z0-9._-]+$/.test(nameValue)) {
    throw new Error(
      `SKILL.md name '${nameValue}' contains invalid characters. Only [A-Za-z0-9._-] allowed.`,
    );
  }

  return { name: nameValue };
}

// ── Path resolution ──────────────────────────────────────────────

export interface SkillPaths {
  /** Primary upload target — the immutableDir/skills/{name}/ symlink path */
  uploadDir: string;
  /** OpenClaw-only: $HOME/.openclaw/skills/{name}/ mirror path, or null */
  mirrorDir: string | null;
  /** OpenClaw-only: session index to clear, or null */
  sessionFile: string | null;
  /** Whether the agent is OpenClaw (drives mirror + refresh behavior) */
  isOpenClaw: boolean;
}

/**
 * Resolve skill install paths from the agent definition.
 * @param agent - AgentDefinition from getSessionAgent(), or null for OpenClaw
 * @param skillName - validated skill name from frontmatter
 */
export function resolveSkillPaths(
  agent: { name: string; configPaths: { immutableDir: string; writableDir: string } } | null,
  skillName: string,
): SkillPaths {
  const isOpenClaw = !agent || agent.name === "openclaw";

  const immutableDir = agent ? agent.configPaths.immutableDir : "/sandbox/.openclaw";
  const writableDir = agent ? agent.configPaths.writableDir : "/sandbox/.openclaw-data";

  const uploadDir = `${immutableDir}/skills/${skillName}`;

  return {
    uploadDir,
    // Mirror uses $HOME at runtime — the sandbox user's home varies
    // (/sandbox on stock images, /home/sandbox on some custom images).
    // We expand $HOME in the SSH command rather than hardcoding a path.
    mirrorDir: isOpenClaw ? `\$HOME/.openclaw/skills/${skillName}` : null,
    sessionFile: isOpenClaw ? `${writableDir}/agents/main/sessions/sessions.json` : null,
    isOpenClaw,
  };
}

// ── Shell safety ─────────────────────────────────────────────────

// Re-export shellQuote from runner.ts — a repo-wide test enforces
// a single definition lives in runner.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
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
 * Uses the same SSH flags as executeSandboxCommand in nemoclaw.ts.
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
        "-F", ctx.configFile,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10",
        "-o", "LogLevel=ERROR",
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
        if (entry.isFile()) skippedDotfiles.push(rel);
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
    const remoteSubdir = rel.includes("/")
      ? `${remoteDir}/${path.dirname(rel)}`
      : remoteDir;
    const result = uploadFile(ctx, localFile, remoteSubdir, path.basename(rel));
    if (!result || result.status !== 0) {
      failed.push(rel);
    }
  }
  return { uploaded: files.length - failed.length, failed, skippedDotfiles, unsafePaths };
}

/**
 * Run post-install steps: OpenClaw mirror + session refresh, or
 * non-OpenClaw restart hint.
 * @param localSkillDir - the skill directory (contains SKILL.md and optional siblings)
 */
export function postInstall(
  ctx: SshContext,
  paths: SkillPaths,
  localSkillDir: string,
  opts: { skipRefresh?: boolean } = {},
): { success: boolean; messages: string[] } {
  const messages: string[] = [];

  if (paths.isOpenClaw) {
    // Mirror to $HOME/.openclaw/skills/ — OpenClaw resolves skills from
    // ~/.openclaw/skills/ via os.homedir(). Use double quotes so $HOME
    // expands on the remote shell (the sandbox user's home varies:
    // /sandbox on stock images, /home/sandbox on custom images).
    if (paths.mirrorDir) {
      const { files } = collectFiles(localSkillDir);
      let mirrorFailed = false;
      for (const rel of files) {
        const content = fs.readFileSync(path.join(localSkillDir, rel));
        const mirrorSubdir = rel.includes("/")
          ? `${paths.mirrorDir}/${path.dirname(rel)}`
          : paths.mirrorDir;
        const mirrorFile = `${paths.mirrorDir}/${rel}`;
        // mirrorDir contains $HOME which must expand, so we use double
        // quotes for the mkdir target but shellQuote the relative part
        // to prevent injection from file names.
        const result = sshExec(
          ctx,
          `mkdir -p "${mirrorSubdir}" && cat > "${mirrorFile}"`,
          { input: content },
        );
        if (!result || result.status !== 0) {
          mirrorFailed = true;
        }
      }
      if (mirrorFailed) {
        messages.push("Warning: failed to mirror some files to $HOME/.openclaw/skills/");
      }
    }

    // Clear sessions.json so OpenClaw re-discovers skills on next session.
    // Skip on updates — the agent already knows the skill, and clearing
    // sessions would destroy chat history unnecessarily.
    if (paths.sessionFile && !opts.skipRefresh) {
      const refreshResult = sshExec(ctx, `printf '{}' > ${shellQuote(paths.sessionFile)}`);
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
 * Check whether a skill already exists on the sandbox at the upload path.
 */
export function checkExisting(ctx: SshContext, paths: SkillPaths): boolean {
  const target = shellQuote(`${paths.uploadDir}/SKILL.md`);
  const result = sshExec(ctx, `test -f ${target} && echo EXISTS`);
  return result !== null && result.stdout === "EXISTS";
}

/**
 * Verify the SKILL.md file exists on the sandbox at the expected path.
 */
export function verifyInstall(ctx: SshContext, paths: SkillPaths): boolean {
  const target = shellQuote(`${paths.uploadDir}/SKILL.md`);
  const result = sshExec(ctx, `test -f ${target} && echo EXISTS`);
  return result !== null && result.stdout === "EXISTS";
}
