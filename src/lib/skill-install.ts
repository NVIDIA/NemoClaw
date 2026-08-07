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
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// yaml is a production dependency (used by policies.ts, onboard.ts)
import YAML from "yaml";

import { isObjectRecord } from "./core/json-types";
import { validateSkillName } from "./skill-name";
import type { SshContext, SshResult } from "./skill-remote";
import { shellQuote, sshExec } from "./skill-remote";

export { validateSkillName } from "./skill-name";
export {
  checkExisting,
  type RemoveResult,
  removeSkill,
  type SshContext,
  type SshResult,
  shellQuote,
  sshExec,
  verifyRemove,
} from "./skill-remote";

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

  if (!isObjectRecord(parsed)) {
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
  /** Agent state root that contains the resolved skill paths. */
  stateDir: string;
  /** Upload target directory for the skill */
  uploadDir: string;
  /** Directory the agent actually loads skills from, or null when it equals uploadDir */
  mirrorDir: string | null;
  /**
   * Whether the agent's own tooling also writes into uploadDir. Shared
   * destinations support only atomic fresh installs because their existing
   * content is not proof that NemoClaw owns it.
   */
  uploadDirSharedWithAgent: boolean;
  /** OpenClaw-only: session index to clear, or null */
  sessionFile: string | null;
  /** Whether a fresh agent session reloads skills without a gateway restart */
  reloadsSkillsOnSessionStart: boolean;
  /** Whether the agent is OpenClaw (drives refresh behavior) */
  isOpenClaw: boolean;
}

/**
 * Agents whose loader reads skills from somewhere other than `uploadDir`.
 *
 * NemoClaw uploads to `uploadDir`, which the agent manifest declares as durable
 * `state_dirs`, but the agent scans its own directory at session start. Where
 * those diverge, an upload without a mirror leaves the skill on disk and
 * unregistered — absent from the agent's skill list (#4819 for OpenClaw, #7634
 * for Deep Agents Code, whose user skill dir is `~/.deepagents/{agent}/skills`).
 *
 * Remove an entry when its agent starts loading skills from `uploadDir`.
 */
const AGENT_SKILL_MIRRORS: Record<string, (dir: string, skillName: string) => string> = {
  openclaw: (_dir, skillName) => `$HOME/.openclaw/skills/${skillName}`,
};

/**
 * Agent-owned skill directories that are also the loader's canonical source.
 *
 * Deep Agents Code's built-in skill creator writes directly to
 * `agent/skills` (#5753). NemoClaw therefore installs there only when the
 * destination is absent and never treats an existing directory as managed.
 */
const AGENT_SHARED_SKILL_DIRS: Record<string, (dir: string, skillName: string) => string> = {
  "langchain-deepagents-code": (dir, skillName) => `${dir}/agent/skills/${skillName}`,
};

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
  const agentName = agent ? agent.name : "openclaw";
  const sharedDir = AGENT_SHARED_SKILL_DIRS[agentName];
  const mirror = AGENT_SKILL_MIRRORS[agentName];

  return {
    stateDir: dir,
    uploadDir: sharedDir ? sharedDir(dir, skillName) : `${dir}/skills/${skillName}`,
    mirrorDir: mirror ? mirror(dir, skillName) : null,
    uploadDirSharedWithAgent: Boolean(sharedDir),
    sessionFile: isOpenClaw ? `${dir}/agents/main/sessions/sessions.json` : null,
    reloadsSkillsOnSessionStart: agentName === "hermes",
    isOpenClaw,
  };
}

// ── Shell safety ─────────────────────────────────────────────────

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

// ── Upload helpers ───────────────────────────────────────────────

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
  unsupportedPaths: string[];
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
  const unsupportedPaths: string[] = [];

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
      } else {
        // Never follow symlinks or copy sockets, FIFOs, or device nodes across
        // the host-to-sandbox trust boundary.
        unsupportedPaths.push(rel);
      }
    }
  }
  walk(dir, "");
  files.sort();
  skippedDotfiles.sort();
  unsafePaths.sort();
  unsupportedPaths.sort();
  return { files, skippedDotfiles, unsafePaths, unsupportedPaths };
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
  const { files, skippedDotfiles, unsafePaths, unsupportedPaths } = collectFiles(localDir);
  const rejected = [...unsafePaths, ...unsupportedPaths];
  if (rejected.length > 0) {
    return { uploaded: 0, failed: rejected, skippedDotfiles, unsafePaths };
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

const SHA256_RE = /^[a-f0-9]{64}$/;
const SKILL_SNAPSHOT_TIMEOUT_MS = 30_000;

function fileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function normalizedSkillFileMode(filePath: string): "644" | "755" {
  return (fs.lstatSync(filePath).mode & 0o111) === 0 ? "644" : "755";
}

/** Hash the sorted regular-file path, normalized mode, and byte set used by a skill archive. */
export function computeSkillContentDigest(localDir: string, files?: string[]): string {
  const selected = files ?? collectFiles(localDir).files;
  const manifest = selected
    .slice()
    .sort()
    .map((rel) => {
      const filePath = path.join(localDir, rel);
      return `${normalizedSkillFileMode(filePath)} ${fileSha256(filePath)}  ${rel}\n`;
    })
    .join("");
  return createHash("sha256").update(manifest).digest("hex");
}

interface SkillArchiveSnapshot {
  archive: Buffer;
  contentDigest: string;
  files: string[];
  skillName: string;
}

export interface SkillRootIdentity {
  dev: number;
  ino: number;
}

function matchesSkillRootIdentity(stat: fs.Stats, expected: SkillRootIdentity): boolean {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.dev === expected.dev &&
    stat.ino === expected.ino
  );
}

function isPathInsideRoot(root: string, candidate: string, expectedRelativePath: string): boolean {
  const relative = path.relative(root, candidate);
  const expected = path.normalize(expectedRelativePath);
  return (
    relative === expected &&
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function copyRegularFileIntoSnapshot(
  sourceRoot: string,
  snapshotDir: string,
  relativePath: string,
): boolean {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonblock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof nonblock !== "number") return false;

  const sourcePath = path.join(sourceRoot, relativePath);
  let sourceDescriptor: number | undefined;
  try {
    sourceDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow | nonblock);
    const opened = fs.fstatSync(sourceDescriptor);
    if (!opened.isFile()) return false;

    const content = fs.readFileSync(sourceDescriptor);
    const after = fs.lstatSync(sourcePath);
    const afterRealPath = fs.realpathSync(sourcePath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !isPathInsideRoot(sourceRoot, afterRealPath, relativePath)
    ) {
      return false;
    }

    const destination = path.join(snapshotDir, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.writeFileSync(destination, content, {
      flag: "wx",
      mode: (opened.mode & 0o111) === 0 ? 0o644 : 0o755,
    });
    return true;
  } catch {
    return false;
  } finally {
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
  }
}

/**
 * Copy validated regular files into a private snapshot with no-follow opens,
 * then create the archive and manifest only from that immutable snapshot.
 */
function createSkillArchiveSnapshot(
  localDir: string,
  files: string[],
  expectedRootIdentity: SkillRootIdentity,
  opts: {
    beforeSnapshotFileRead?: (relativePath: string) => void;
    beforeSnapshotRootRead?: () => void;
  } = {},
): SkillArchiveSnapshot | null {
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-snapshot-"));
  try {
    fs.chmodSync(snapshotDir, 0o700);
    opts.beforeSnapshotRootRead?.();
    let sourceRoot: string;
    try {
      const selectedRoot = fs.lstatSync(localDir);
      if (!matchesSkillRootIdentity(selectedRoot, expectedRootIdentity)) return null;

      sourceRoot = fs.realpathSync(localDir);
      const rootStat = fs.lstatSync(sourceRoot);
      if (!matchesSkillRootIdentity(rootStat, expectedRootIdentity)) return null;
    } catch {
      return null;
    }

    for (const relativePath of files.slice().sort()) {
      opts.beforeSnapshotFileRead?.(relativePath);
      if (!copyRegularFileIntoSnapshot(sourceRoot, snapshotDir, relativePath)) return null;
    }

    const snapshot = collectFiles(snapshotDir);
    if (
      snapshot.unsafePaths.length > 0 ||
      snapshot.unsupportedPaths.length > 0 ||
      !snapshot.files.includes("SKILL.md") ||
      snapshot.files.join("\n") !== files.slice().sort().join("\n")
    ) {
      return null;
    }

    const archiveResult = spawnSync(
      "tar",
      ["-cf", "-", "-C", snapshotDir, "--", ...snapshot.files],
      {
        encoding: null,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        maxBuffer: 256 * 1024 * 1024,
        timeout: SKILL_SNAPSHOT_TIMEOUT_MS,
      },
    );
    if (archiveResult.status !== 0 || !Buffer.isBuffer(archiveResult.stdout)) return null;

    let skillName: string;
    try {
      skillName = parseFrontmatter(
        fs.readFileSync(path.join(snapshotDir, "SKILL.md"), "utf8"),
      ).name;
    } catch {
      return null;
    }
    return {
      archive: archiveResult.stdout,
      contentDigest: computeSkillContentDigest(snapshotDir, snapshot.files),
      files: snapshot.files,
      skillName,
    };
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function buildFreshSharedInstallScript(paths: SkillPaths, expectedDigest: string): string {
  const relativeUpload = path.posix.relative(paths.stateDir, paths.uploadDir);
  const parentParts = path.posix.dirname(relativeUpload).split("/");
  const leaf = path.posix.basename(relativeUpload);
  if (
    !validateRelativePath(relativeUpload) ||
    parentParts.some((part) => !validateRelativePath(part)) ||
    !validateRelativePath(leaf)
  ) {
    throw new Error("Shared agent skill path is not a safe relative destination");
  }

  const lines = [
    "set -eu",
    `root=${shellQuote(paths.stateDir)}`,
    `leaf=${shellQuote(leaf)}`,
    `expected=${shellQuote(expectedDigest)}`,
    'exists() { [ -e "$1" ] || [ -L "$1" ]; }',
    'safe_rel() { case "$1" in ""|/*|*//*|*[!A-Za-z0-9._/-]*) return 1 ;; esac; case "/$1/" in *"/./"*|*"/../"*) return 1 ;; esac; }',
    '[ -d "$root" ] && [ ! -L "$root" ] && [ "$(realpath -e -- "$root")" = "$root" ]',
    'cd -P -- "$root"',
    '[ "$(pwd -P)" = "$root" ]',
  ];

  let expectedParent = paths.stateDir;
  for (const part of parentParts) {
    expectedParent = `${expectedParent}/${part}`;
    lines.push(
      `part=${shellQuote(part)}`,
      '[ ! -L "$part" ]',
      'if [ ! -e "$part" ]; then mkdir -- "$part"; fi',
      '[ -d "$part" ] && [ ! -L "$part" ]',
      'cd -P -- "$part"',
      `[ "$(pwd -P)" = ${shellQuote(expectedParent)} ]`,
    );
  }

  lines.push(
    'if exists "$leaf"; then echo EXISTS; exit 2; fi',
    'workspace="$(mktemp -d .nemoclaw-skill.XXXXXX)"',
    'chmod 700 "$workspace"',
    'payload="$workspace/payload"',
    'cleanup() { if exists "$workspace"; then rm -rf -- "$workspace"; fi; }',
    "trap cleanup EXIT HUP INT TERM",
    'mkdir -- "$payload"',
    'tar --no-same-owner -xf - -C "$payload"',
    '[ -z "$(find "$payload" -mindepth 1 ! -type d ! -type f -print -quit)" ]',
    'find "$payload" -type d -exec chmod 755 {} +',
    'find "$payload" -type f -perm /111 -exec chmod 755 {} +',
    'find "$payload" -type f ! -perm /111 -exec chmod 644 {} +',
    'find "$payload" -type f -printf "%P\\n" | LC_ALL=C sort > "$workspace/files"',
    ': > "$workspace/manifest"',
    'while IFS= read -r rel; do safe_rel "$rel"; mode="$(stat -c "%a" "$payload/$rel")"; hash="$(sha256sum "$payload/$rel" | cut -d " " -f 1)"; printf "%s %s  %s\\n" "$mode" "$hash" "$rel" >> "$workspace/manifest"; done < "$workspace/files"',
    'staged="$(sha256sum "$workspace/manifest" | cut -d " " -f 1)"',
    '[ "$staged" = "$expected" ]',
    'if exists "$leaf"; then echo EXISTS; exit 2; fi',
    'if ! mv -nT -- "$payload" "$leaf"; then if exists "$leaf"; then echo EXISTS; exit 2; fi; echo MOVE_FAILED; exit 3; fi',
    'if exists "$payload"; then echo EXISTS; exit 2; fi',
    'printf "INSTALLED %s\\n" "$expected"',
  );
  return lines.join("; ");
}

export interface FreshSharedSkillInstallResult {
  success: boolean;
  uploaded: number;
  contentDigest?: string;
  reason?: "destination_exists" | "snapshot_failed" | "remote_state_unknown";
}

/**
 * Install into an agent-owned loader directory only when the destination is
 * absent. Existing content is never renamed, deleted, or replaced.
 */
export function installFreshSharedSkill(
  ctx: SshContext,
  localDir: string,
  paths: SkillPaths,
  opts: {
    beforeSnapshotFileRead?: (relativePath: string) => void;
    beforeSnapshotRootRead?: () => void;
    expectedRootIdentity?: SkillRootIdentity;
    sshExecImpl?: typeof sshExec;
  } = {},
): FreshSharedSkillInstallResult {
  if (!paths.uploadDirSharedWithAgent || paths.mirrorDir) {
    return { success: false, uploaded: 0, reason: "remote_state_unknown" };
  }
  let expectedRootIdentity = opts.expectedRootIdentity;
  if (!expectedRootIdentity) {
    try {
      const rootStat = fs.lstatSync(localDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        return { success: false, uploaded: 0, reason: "snapshot_failed" };
      }
      expectedRootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
    } catch {
      return { success: false, uploaded: 0, reason: "snapshot_failed" };
    }
  }
  const collected = collectFiles(localDir);
  if (
    collected.files.length === 0 ||
    collected.unsafePaths.length > 0 ||
    collected.unsupportedPaths.length > 0
  ) {
    return { success: false, uploaded: 0, reason: "snapshot_failed" };
  }
  const snapshot = createSkillArchiveSnapshot(localDir, collected.files, expectedRootIdentity, {
    beforeSnapshotFileRead: opts.beforeSnapshotFileRead,
    beforeSnapshotRootRead: opts.beforeSnapshotRootRead,
  });
  if (
    !snapshot ||
    !SHA256_RE.test(snapshot.contentDigest) ||
    snapshot.skillName !== path.posix.basename(paths.uploadDir)
  ) {
    return { success: false, uploaded: 0, reason: "snapshot_failed" };
  }
  const runSsh = opts.sshExecImpl ?? sshExec;
  const result = runSsh(ctx, buildFreshSharedInstallScript(paths, snapshot.contentDigest), {
    input: snapshot.archive,
  });
  if (
    result !== null &&
    result.status === 0 &&
    result.stdout === `INSTALLED ${snapshot.contentDigest}`
  ) {
    return {
      success: true,
      uploaded: snapshot.files.length,
      contentDigest: snapshot.contentDigest,
    };
  }
  return {
    success: false,
    uploaded: 0,
    reason:
      result?.status === 2 && result.stdout === "EXISTS"
        ? "destination_exists"
        : "remote_state_unknown",
  };
}

/**
 * Run post-install steps: skill-load mirror for every agent that needs one,
 * session refresh for OpenClaw, and agent-specific activation guidance.
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

  // Copy the skill into the directory the agent's loader actually reads; see
  // AGENT_SKILL_MIRRORS for which agents need this and why. Without it the
  // upload never registers as a skill. `skill remove` deletes the mirror, so
  // install must create it to stay symmetric. The copy is skipped when both
  // paths resolve to the same directory, so it is a no-op for agents whose
  // loader reads uploadDir directly.
  if (paths.mirrorDir) {
    const src = shellQuote(paths.uploadDir);
    // mirrorDir may contain $HOME, which must expand on the remote shell, so we
    // use double quotes (not shellQuote). Safe because skill names are
    // restricted to [A-Za-z0-9._-] by parseFrontmatter / the name regex.
    const dst = `"${paths.mirrorDir}"`;
    const mirrorParent = `"${paths.mirrorDir.slice(0, paths.mirrorDir.lastIndexOf("/"))}"`;
    const mirrorResult = runSsh(
      ctx,
      `[ ${src} -ef ${dst} ] || { mkdir -p ${mirrorParent} && rm -rf ${dst} && cp -a ${src} ${dst}; }`,
    );
    if (!mirrorResult || mirrorResult.status !== 0) {
      messages.push(
        `Warning: failed to mirror skill into ${paths.mirrorDir} (agent may not load it)`,
      );
    }
  }

  // Clear sessions.json so OpenClaw re-discovers skills on the next
  // session even after an in-place skill update.
  if (paths.sessionFile && !opts.skipRefresh) {
    const refreshResult = runSsh(ctx, `printf '{}' > ${shellQuote(paths.sessionFile)}`);
    if (!refreshResult || refreshResult.status !== 0) {
      messages.push("Warning: failed to clear sessions (agent may need manual restart)");
    }
  }

  if (!paths.mirrorDir && !paths.sessionFile) {
    messages.push(
      paths.reloadsSkillsOnSessionStart
        ? "Start a new chat session to load the skill; a gateway restart is not required."
        : "Restart the agent gateway to pick up the new skill.",
    );
  }

  return { success: true, messages };
}

/**
 * Verify the SKILL.md file exists on the sandbox.
 *
 * When the agent has a mirror directory it must also exist: that is the path
 * the agent loads skills from at session start (#4819 for OpenClaw, #7634 for
 * Deep Agents Code), so a successful upload whose mirror copy failed must NOT
 * verify as installed — otherwise the CLI reports success while the skill stays
 * invisible to the agent. This mirrors verifyRemove(), which already checks
 * both paths.
 */
export function verifyInstall(
  ctx: SshContext,
  paths: SkillPaths,
  opts: { sshExecImpl?: typeof sshExec } = {},
): boolean {
  const checks = [`test -f ${shellQuote(`${paths.uploadDir}/SKILL.md`)}`];
  if (paths.mirrorDir) {
    // mirrorDir may contain $HOME, which must expand on the remote shell, so we
    // use double quotes (not shellQuote) — safe because skill names are
    // restricted to [A-Za-z0-9._-].
    checks.push(`test -f "${paths.mirrorDir}/SKILL.md"`);
  }
  const runSsh = opts.sshExecImpl ?? sshExec;
  const result = runSsh(ctx, `${checks.join(" && ")} && echo EXISTS`);
  return result !== null && result.stdout === "EXISTS";
}
