// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Skill install/remove logic for `nemoclaw <sandbox> skill install <path>`
// and `nemoclaw <sandbox> skill remove <name>`.
// Validates local SKILL.md content and applies the selected agent's install
// contract. OpenClaw uses its native workspace installer after secure staging;
// generic agents retain the direct upload path and activation guidance.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// yaml is a production dependency (used by policies.ts, onboard.ts)
import YAML from "yaml";

import { isObjectRecord } from "./core/json-types";
import { validateSkillName } from "./skill-name";
import type { SshContext, SshResult } from "./skill-remote";
import { shellQuote, sshExec } from "./skill-remote";
import { ensureConfigDir, rejectSymlinksOnPath } from "./state/config-io";
import { resolveNemoclawStateDir } from "./state/paths";

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
  /**
   * Whether the agent's own tooling also writes into uploadDir. Shared
   * destinations support only atomic fresh installs because their existing
   * content is not proof that NemoClaw owns it.
   */
  uploadDirSharedWithAgent: boolean;
  /** Whether a fresh agent session reloads skills without a gateway restart */
  reloadsSkillsOnSessionStart: boolean;
  /** Whether the agent is OpenClaw (drives refresh behavior) */
  isOpenClaw: boolean;
}

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
  return {
    stateDir: dir,
    uploadDir:
      (isOpenClaw ? `${dir}/workspace/skills/${skillName}` : null) ??
      (sharedDir ? sharedDir(dir, skillName) : `${dir}/skills/${skillName}`),
    uploadDirSharedWithAgent: Boolean(sharedDir),
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
export const SKILL_SNAPSHOT_MAX_FILES = 1024;
export const SKILL_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const OPENCLAW_NATIVE_BIN = "/usr/local/bin/openclaw";

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

/** Read exactly one already-bounded regular file and reject concurrent size changes. */
function readBoundedSnapshotFile(descriptor: number, size: number): Buffer | null {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = fs.readSync(descriptor, content, offset, size - offset, null);
    if (bytesRead === 0) return null;
    offset += bytesRead;
  }
  const extra = Buffer.alloc(1);
  return fs.readSync(descriptor, extra, 0, 1, null) === 0 ? content : null;
}

function copyRegularFileIntoSnapshot(
  sourceRoot: string,
  snapshotDir: string,
  relativePath: string,
  remainingBytes: number,
): number | "limit_exceeded" | null {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonblock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof nonblock !== "number") return null;

  const sourcePath = path.join(sourceRoot, relativePath);
  let sourceDescriptor: number | undefined;
  try {
    sourceDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow | nonblock);
    const opened = fs.fstatSync(sourceDescriptor);
    if (!opened.isFile() || !Number.isSafeInteger(opened.size) || opened.size < 0) return null;
    if (opened.size > remainingBytes) return "limit_exceeded";

    const content = readBoundedSnapshotFile(sourceDescriptor, opened.size);
    if (!content) return null;
    const after = fs.lstatSync(sourcePath);
    const afterRealPath = fs.realpathSync(sourcePath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !isPathInsideRoot(sourceRoot, afterRealPath, relativePath)
    ) {
      return null;
    }

    const destination = path.join(snapshotDir, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.writeFileSync(destination, content, {
      flag: "wx",
      mode: (opened.mode & 0o111) === 0 ? 0o644 : 0o755,
    });
    return content.length;
  } catch {
    return null;
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
): SkillArchiveSnapshot | "limit_exceeded" | null {
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

    let totalBytes = 0;
    for (const relativePath of files.slice().sort()) {
      opts.beforeSnapshotFileRead?.(relativePath);
      const copied = copyRegularFileIntoSnapshot(
        sourceRoot,
        snapshotDir,
        relativePath,
        SKILL_SNAPSHOT_MAX_BYTES - totalBytes,
      );
      if (copied === "limit_exceeded") return copied;
      if (copied === null) return null;
      totalBytes += copied;
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

type SkillSnapshotOptions = {
  beforeSnapshotFileRead?: (relativePath: string) => void;
  beforeSnapshotRootRead?: () => void;
  expectedRootIdentity?: SkillRootIdentity;
};

/** Prepare the single bounded host snapshot contract shared by native publishers. */
function prepareSkillArchiveSnapshot(
  localDir: string,
  opts: SkillSnapshotOptions,
): SkillArchiveSnapshot | "limit_exceeded" | null {
  let expectedRootIdentity = opts.expectedRootIdentity;
  if (!expectedRootIdentity) {
    try {
      const rootStat = fs.lstatSync(localDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
      expectedRootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
    } catch {
      return null;
    }
  }
  const collected = collectFiles(localDir);
  if (collected.files.length > SKILL_SNAPSHOT_MAX_FILES) return "limit_exceeded";
  if (
    collected.files.length === 0 ||
    collected.unsafePaths.length > 0 ||
    collected.unsupportedPaths.length > 0
  ) {
    return null;
  }
  const snapshot = createSkillArchiveSnapshot(
    localDir,
    collected.files,
    expectedRootIdentity,
    opts,
  );
  if (snapshot === null || snapshot === "limit_exceeded") return snapshot;
  return SHA256_RE.test(snapshot.contentDigest) ? snapshot : null;
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
  reason?:
    | "destination_exists"
    | "legacy_destination_exists"
    | "native_capability_missing"
    | "provenance_failed"
    | "provenance_finalization_failed"
    | "remote_state_unknown"
    | "snapshot_failed"
    | "snapshot_limit_exceeded"
    | "staging_collision"
    | "update_unsupported"
    | "verification_failed";
}

const OPENCLAW_PROVENANCE_MAX_BYTES = 4096;
const OPENCLAW_STAGE_NONCE_RE = /^[a-f0-9]{32}$/u;

interface OpenClawSkillProvenance {
  readonly schemaVersion: 1;
  readonly sandboxIdentityFingerprint: string;
  readonly sandboxName: string;
  readonly skillName: string;
  readonly targetDir: string;
  readonly phase: "installed" | "pending";
  readonly contentDigest: string;
  readonly previousDigest: string | null;
  readonly stageNonce: string | null;
}

/** Resolve the host-protected ownership receipt for one exact OpenClaw sandbox identity. */
export function resolveOpenClawSkillProvenancePath(
  sandboxIdentityFingerprint: string,
  skillName: string,
  stateDir = resolveNemoclawStateDir(),
): string {
  if (!SHA256_RE.test(sandboxIdentityFingerprint) || !validateSkillName(skillName)) {
    throw new Error("OpenClaw skill provenance identity is invalid");
  }
  return path.join(
    stateDir,
    "openclaw-skill-installs",
    sandboxIdentityFingerprint,
    `${skillName}.json`,
  );
}

/** Remove every host-protected skill receipt owned by one destroyed sandbox identity. */
export function removeOpenClawSkillProvenanceForSandboxIdentity(
  sandboxIdentityFingerprint: string,
  stateDir = resolveNemoclawStateDir(),
): void {
  if (!SHA256_RE.test(sandboxIdentityFingerprint)) {
    throw new Error("OpenClaw skill provenance identity is invalid");
  }
  const provenanceRoot = path.join(stateDir, "openclaw-skill-installs");
  const sandboxProvenanceDir = path.join(provenanceRoot, sandboxIdentityFingerprint);
  rejectSymlinksOnPath(sandboxProvenanceDir);

  let provenanceRootStat: fs.Stats;
  try {
    provenanceRootStat = fs.lstatSync(provenanceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!provenanceRootStat.isDirectory() || provenanceRootStat.isSymbolicLink()) {
    throw new Error("OpenClaw skill provenance root is not a regular directory");
  }

  let sandboxProvenanceStat: fs.Stats;
  try {
    sandboxProvenanceStat = fs.lstatSync(sandboxProvenanceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sandboxProvenanceStat.isDirectory() || sandboxProvenanceStat.isSymbolicLink()) {
    throw new Error("OpenClaw sandbox skill provenance is not a regular directory");
  }

  for (const entry of fs.readdirSync(sandboxProvenanceDir, { withFileTypes: true })) {
    const entryPath = path.join(sandboxProvenanceDir, entry.name);
    const entryStat = fs.lstatSync(entryPath);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      throw new Error("OpenClaw sandbox skill provenance contains an unsupported entry");
    }
    // unlink removes the exact directory entry and never follows a final symlink.
    fs.unlinkSync(entryPath);
  }
  fs.rmdirSync(sandboxProvenanceDir);
  syncDirectory(provenanceRoot);
}

/** Validate an ownership receipt against its exact host and sandbox identity. */
function isOpenClawSkillProvenance(
  value: unknown,
  expected: Omit<
    OpenClawSkillProvenance,
    "contentDigest" | "phase" | "previousDigest" | "stageNonce"
  >,
): value is OpenClawSkillProvenance {
  if (!isObjectRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    value.sandboxIdentityFingerprint === expected.sandboxIdentityFingerprint &&
    value.sandboxName === expected.sandboxName &&
    value.skillName === expected.skillName &&
    value.targetDir === expected.targetDir &&
    (value.phase === "installed" || value.phase === "pending") &&
    typeof value.contentDigest === "string" &&
    SHA256_RE.test(value.contentDigest) &&
    (value.previousDigest === null ||
      (typeof value.previousDigest === "string" && SHA256_RE.test(value.previousDigest))) &&
    (value.phase !== "installed" || value.previousDigest === null) &&
    ((value.phase === "pending" &&
      typeof value.stageNonce === "string" &&
      OPENCLAW_STAGE_NONCE_RE.test(value.stageNonce)) ||
      (value.phase === "installed" && value.stageNonce === null))
  );
}

/** Read a bounded private ownership receipt without following its final path. */
function readOpenClawSkillProvenance(
  receiptPath: string,
  expected: Omit<
    OpenClawSkillProvenance,
    "contentDigest" | "phase" | "previousDigest" | "stageNonce"
  >,
): OpenClawSkillProvenance | null {
  ensureConfigDir(path.dirname(receiptPath));
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("OpenClaw skill provenance requires O_NOFOLLOW support");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      receiptPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const pinned = fs.fstatSync(descriptor);
    if (
      !pinned.isFile() ||
      (pinned.mode & 0o077) !== 0 ||
      pinned.size > OPENCLAW_PROVENANCE_MAX_BYTES
    ) {
      throw new Error("OpenClaw skill provenance is not a bounded private regular file");
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!isOpenClawSkillProvenance(parsed, expected)) {
      throw new Error("OpenClaw skill provenance failed validation");
    }
    return parsed;
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Flush a directory entry update before reporting durable provenance. */
function syncDirectory(dirPath: string): void {
  const descriptor = fs.openSync(dirPath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Atomically publish one private host ownership receipt. */
function writeOpenClawSkillProvenance(receiptPath: string, receipt: OpenClawSkillProvenance): void {
  const receiptDir = path.dirname(receiptPath);
  ensureConfigDir(receiptDir);
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("OpenClaw skill provenance requires O_NOFOLLOW support");
  }
  const temporaryPath = path.join(
    receiptDir,
    `.${path.basename(receiptPath)}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt)}\n`, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, receiptPath);
    syncDirectory(receiptDir);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

/** Publish a receipt only when its final path is absent. */
function writeOpenClawSkillProvenanceIfAbsent(
  receiptPath: string,
  receipt: OpenClawSkillProvenance,
): boolean {
  const receiptDir = path.dirname(receiptPath);
  ensureConfigDir(receiptDir);
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("OpenClaw skill provenance requires O_NOFOLLOW support");
  }
  const temporaryPath = path.join(
    receiptDir,
    `.${path.basename(receiptPath)}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt)}\n`, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporaryPath, receiptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    syncDirectory(receiptDir);
    return true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function sameOpenClawSkillProvenance(
  left: OpenClawSkillProvenance,
  right: OpenClawSkillProvenance,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.sandboxIdentityFingerprint === right.sandboxIdentityFingerprint &&
    left.sandboxName === right.sandboxName &&
    left.skillName === right.skillName &&
    left.targetDir === right.targetDir &&
    left.phase === right.phase &&
    left.contentDigest === right.contentDigest &&
    left.previousDigest === right.previousDigest &&
    left.stageNonce === right.stageNonce
  );
}

/** Durably move exact OpenClaw skill receipts to a proven replacement sandbox identity. */
export function transferOpenClawSkillProvenanceForSandboxReplacement(
  sandboxName: string,
  sourceSandboxIdentityFingerprint: string,
  targetSandboxIdentityFingerprint: string,
  stateDir = resolveNemoclawStateDir(),
): void {
  if (
    !SHA256_RE.test(sourceSandboxIdentityFingerprint) ||
    !SHA256_RE.test(targetSandboxIdentityFingerprint)
  ) {
    throw new Error("OpenClaw skill provenance replacement identity is invalid");
  }
  if (sourceSandboxIdentityFingerprint === targetSandboxIdentityFingerprint) return;

  const provenanceRoot = path.join(stateDir, "openclaw-skill-installs");
  const sourceDir = path.join(provenanceRoot, sourceSandboxIdentityFingerprint);
  rejectSymlinksOnPath(sourceDir);
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(sourceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("OpenClaw source skill provenance is not a regular directory");
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  if (entries.length > SKILL_SNAPSHOT_MAX_FILES) {
    throw new Error("OpenClaw source skill provenance exceeds the transfer limit");
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const suffix = ".json";
    const skillName = entry.name.endsWith(suffix) ? entry.name.slice(0, -suffix.length) : "";
    const sourcePath = path.join(sourceDir, entry.name);
    const sourceEntryStat = fs.lstatSync(sourcePath);
    if (
      !entry.isFile() ||
      !sourceEntryStat.isFile() ||
      sourceEntryStat.isSymbolicLink() ||
      !validateSkillName(skillName)
    ) {
      throw new Error("OpenClaw source skill provenance contains an unsupported entry");
    }
    const targetDir = resolveSkillPaths(null, skillName).uploadDir;
    const sourceReceipt = readOpenClawSkillProvenance(sourcePath, {
      schemaVersion: 1,
      sandboxIdentityFingerprint: sourceSandboxIdentityFingerprint,
      sandboxName,
      skillName,
      targetDir,
    });
    if (!sourceReceipt) {
      throw new Error("OpenClaw source skill provenance disappeared during transfer");
    }
    const targetReceipt: OpenClawSkillProvenance = {
      ...sourceReceipt,
      sandboxIdentityFingerprint: targetSandboxIdentityFingerprint,
    };
    const targetPath = resolveOpenClawSkillProvenancePath(
      targetSandboxIdentityFingerprint,
      skillName,
      stateDir,
    );
    let existingTarget = readOpenClawSkillProvenance(targetPath, {
      schemaVersion: 1,
      sandboxIdentityFingerprint: targetSandboxIdentityFingerprint,
      sandboxName,
      skillName,
      targetDir,
    });
    if (!existingTarget) {
      writeOpenClawSkillProvenanceIfAbsent(targetPath, targetReceipt);
      existingTarget = readOpenClawSkillProvenance(targetPath, {
        schemaVersion: 1,
        sandboxIdentityFingerprint: targetSandboxIdentityFingerprint,
        sandboxName,
        skillName,
        targetDir,
      });
    }
    if (!existingTarget || !sameOpenClawSkillProvenance(existingTarget, targetReceipt)) {
      throw new Error("OpenClaw replacement skill provenance conflicts with the source receipt");
    }
    fs.unlinkSync(sourcePath);
    syncDirectory(sourceDir);
  }
  fs.rmdirSync(sourceDir);
  syncDirectory(provenanceRoot);
}

/** Restore the pre-attempt receipt after a proven non-mutating remote refusal. */
function restoreOpenClawSkillProvenance(
  receiptPath: string,
  receipt: OpenClawSkillProvenance | null,
): void {
  if (receipt) {
    writeOpenClawSkillProvenance(receiptPath, receipt);
    return;
  }
  try {
    // unlink removes the directory entry itself and never follows a symlink.
    fs.unlinkSync(receiptPath);
    syncDirectory(path.dirname(receiptPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  if (!paths.uploadDirSharedWithAgent) {
    return { success: false, uploaded: 0, reason: "remote_state_unknown" };
  }
  const snapshot = prepareSkillArchiveSnapshot(localDir, {
    beforeSnapshotFileRead: opts.beforeSnapshotFileRead,
    beforeSnapshotRootRead: opts.beforeSnapshotRootRead,
    expectedRootIdentity: opts.expectedRootIdentity,
  });
  if (snapshot === "limit_exceeded") {
    return { success: false, uploaded: 0, reason: "snapshot_limit_exceeded" };
  }
  if (!snapshot || snapshot.skillName !== path.posix.basename(paths.uploadDir)) {
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

function buildOpenClawNativeInstallScript(
  paths: SkillPaths,
  skillName: string,
  expectedDigest: string,
  previousDigest: string | null,
  stageNonce: string,
  resumePendingStage: boolean,
): string {
  if (!paths.isOpenClaw) {
    throw new Error("OpenClaw native install requires a workspace skill destination");
  }
  if (!OPENCLAW_STAGE_NONCE_RE.test(stageNonce)) {
    throw new Error("OpenClaw native install staging identity is invalid");
  }
  const verifyNativeJson = [
    'const fs=require("node:fs");',
    "const [listPath,infoPath,checkPath,skill,target]=process.argv.slice(1);",
    'const read=(file)=>JSON.parse(fs.readFileSync(file,"utf8"));',
    "const list=read(listPath);const info=read(infoPath);const check=read(checkPath);",
    'const listed=Array.isArray(list.skills)&&list.skills.some((entry)=>entry&&typeof entry==="object"&&entry.name===skill);',
    'const informed=info&&typeof info==="object"&&info.name===skill&&(info.baseDir===target||info.filePath===target+"/SKILL.md");',
    'const checked=check&&typeof check==="object"&&check.agentId==="main"&&Array.isArray(check.eligible)&&check.eligible.includes(skill);',
    "if(!listed||!informed||!checked)process.exit(1);",
  ].join("");
  // The pinned native installer owns source-origin metadata and may recreate
  // payload modes under umask; hash only payload files with normalized modes.
  return [
    "set -eu",
    "umask 077",
    `root=${shellQuote(paths.stateDir)}`,
    `target=${shellQuote(paths.uploadDir)}`,
    `legacy=${shellQuote(`${paths.stateDir}/skills/${skillName}`)}`,
    `skill=${shellQuote(skillName)}`,
    'legacy_home="$HOME/.openclaw/skills/$skill"',
    `expected=${shellQuote(expectedDigest)}`,
    `previous=${shellQuote(previousDigest ?? "")}`,
    `stage_nonce=${shellQuote(stageNonce)}`,
    `resume_stage=${resumePendingStage ? "1" : "0"}`,
    'exists() { [ -e "$1" ] || [ -L "$1" ]; }',
    'safe_tree() { [ -d "$1" ] && [ ! -L "$1" ] && [ -z "$(find "$1" -mindepth 1 ! -type d ! -type f -print -quit)" ]; }',
    'digest_tree() { tree="$1"; manifest="$2"; find "$tree" -type f -printf "%P\\n" | LC_ALL=C sort | grep -Fxv ".openclaw/source-origin.json" > "$manifest.files"; : > "$manifest"; while IFS= read -r rel; do if [ -n "$(find "$tree/$rel" -type f -perm /111 -print -quit)" ]; then mode=755; else mode=644; fi; hash="$(sha256sum "$tree/$rel" | cut -d " " -f 1)"; printf "%s %s  %s\\n" "$mode" "$hash" "$rel" >> "$manifest"; done < "$manifest.files"; sha256sum "$manifest" | cut -d " " -f 1; }',
    '[ -d "$root" ] && [ ! -L "$root" ] && [ "$(realpath -e -- "$root")" = "$root" ]',
    'if exists "$legacy" || exists "$legacy_home"; then echo LEGACY_COLLISION; exit 5; fi',
    'stage="$root/.nemoclaw-skill-stage.$stage_nonce"',
    'if exists "$stage"; then [ "$resume_stage" = 1 ] && safe_tree "$stage" || { echo STAGE_COLLISION; exit 7; }; rm -rf -- "$stage"; fi',
    'mkdir -- "$stage"',
    'chmod 700 "$stage"',
    'cleanup() { rm -rf -- "$stage"; }',
    "trap cleanup EXIT HUP INT TERM",
    'payload="$stage/payload"',
    'mkdir -- "$payload"',
    'tar --no-same-owner -xf - -C "$payload"',
    'safe_tree "$payload"',
    'find "$payload" -type d -exec chmod 755 {} +',
    'find "$payload" -type f -perm /111 -exec chmod 755 {} +',
    'find "$payload" -type f ! -perm /111 -exec chmod 644 {} +',
    'staged="$(digest_tree "$payload" "$stage/staged.manifest")"',
    '[ "$staged" = "$expected" ]',
    `help="$(${shellQuote(OPENCLAW_NATIVE_BIN)} skills install --help 2>&1)" || { echo CAPABILITY_MISSING; exit 3; }`,
    'printf "%s" "$help" | grep -q -- "--agent" || { echo CAPABILITY_MISSING; exit 3; }',
    'action="install"',
    'if exists "$target"; then safe_tree "$target" || { echo COLLISION; exit 2; }; current="$(digest_tree "$target" "$stage/current.manifest")"; if [ -n "$previous" ] && [ "$current" = "$expected" ] && [ "$current" = "$previous" ]; then action="reconcile"; elif [ -n "$previous" ] && [ "$current" = "$previous" ]; then echo UPDATE_UNSUPPORTED; exit 6; else echo COLLISION; exit 2; fi; fi',
    `if [ "$action" = install ]; then ${shellQuote(OPENCLAW_NATIVE_BIN)} skills install "$payload" --agent main; fi`,
    `${shellQuote(OPENCLAW_NATIVE_BIN)} skills list --agent main --json > "$stage/list.json"`,
    `${shellQuote(OPENCLAW_NATIVE_BIN)} skills info "$skill" --agent main --json > "$stage/info.json"`,
    `${shellQuote(OPENCLAW_NATIVE_BIN)} skills check --agent main --json > "$stage/check.json"`,
    `node -e ${shellQuote(verifyNativeJson)} "$stage/list.json" "$stage/info.json" "$stage/check.json" "$skill" "$target" || { echo VERIFY_FAILED; exit 4; }`,
    'safe_tree "$target" || { echo VERIFY_FAILED; exit 4; }',
    'installed="$(digest_tree "$target" "$stage/installed.manifest")"',
    '[ "$installed" = "$expected" ] || { echo VERIFY_FAILED; exit 4; }',
    'if [ "$action" = reconcile ]; then printf "RECONCILED %s\\n" "$installed"; else printf "INSTALLED %s\\n" "$installed"; fi',
  ].join("; ");
}

/**
 * Securely stage a host snapshot and delegate OpenClaw workspace publication,
 * rollback, precedence, and activation to the pinned native installer.
 */
export function installOpenClawSkill(
  ctx: SshContext,
  localDir: string,
  paths: SkillPaths,
  skillName: string,
  opts: {
    beforeSnapshotFileRead?: (relativePath: string) => void;
    beforeSnapshotRootRead?: () => void;
    expectedRootIdentity?: SkillRootIdentity;
    provenanceStateDir?: string;
    sandboxIdentityFingerprint?: string;
    sshExecImpl?: typeof sshExec;
  } = {},
): FreshSharedSkillInstallResult {
  const snapshot = prepareSkillArchiveSnapshot(localDir, {
    beforeSnapshotFileRead: opts.beforeSnapshotFileRead,
    beforeSnapshotRootRead: opts.beforeSnapshotRootRead,
    expectedRootIdentity: opts.expectedRootIdentity,
  });
  if (snapshot === "limit_exceeded") {
    return { success: false, uploaded: 0, reason: "snapshot_limit_exceeded" };
  }
  if (!snapshot || snapshot.skillName !== skillName) {
    return { success: false, uploaded: 0, reason: "snapshot_failed" };
  }
  const sandboxIdentityFingerprint = opts.sandboxIdentityFingerprint ?? "";
  if (!SHA256_RE.test(sandboxIdentityFingerprint)) {
    return { success: false, uploaded: 0, reason: "provenance_failed" };
  }
  const receiptIdentity = {
    schemaVersion: 1 as const,
    sandboxIdentityFingerprint,
    sandboxName: ctx.sandboxName,
    skillName,
    targetDir: paths.uploadDir,
  };
  let receiptPath: string;
  let priorReceipt: OpenClawSkillProvenance | null;
  let stageNonce: string;
  try {
    receiptPath = resolveOpenClawSkillProvenancePath(
      sandboxIdentityFingerprint,
      skillName,
      opts.provenanceStateDir,
    );
    priorReceipt = readOpenClawSkillProvenance(receiptPath, receiptIdentity);
    if (
      priorReceipt?.phase === "pending" &&
      priorReceipt.contentDigest !== snapshot.contentDigest
    ) {
      return { success: false, uploaded: 0, reason: "provenance_failed" };
    }
    stageNonce =
      priorReceipt?.phase === "pending" && priorReceipt.stageNonce
        ? priorReceipt.stageNonce
        : randomBytes(16).toString("hex");
    writeOpenClawSkillProvenance(receiptPath, {
      ...receiptIdentity,
      phase: "pending",
      contentDigest: snapshot.contentDigest,
      previousDigest:
        priorReceipt?.phase === "installed"
          ? priorReceipt.contentDigest
          : (priorReceipt?.previousDigest ?? null),
      stageNonce,
    });
  } catch {
    return { success: false, uploaded: 0, reason: "provenance_failed" };
  }
  const result = (opts.sshExecImpl ?? sshExec)(
    ctx,
    buildOpenClawNativeInstallScript(
      paths,
      skillName,
      snapshot.contentDigest,
      priorReceipt?.phase === "installed"
        ? priorReceipt.contentDigest
        : (priorReceipt?.previousDigest ?? null),
      stageNonce,
      priorReceipt?.phase === "pending",
    ),
    { input: snapshot.archive, timeout: 120_000 },
  );
  const stdout = result?.stdout.trim() ?? "";
  const success =
    result?.status === 0 &&
    (stdout.endsWith(`INSTALLED ${snapshot.contentDigest}`) ||
      stdout.endsWith(`RECONCILED ${snapshot.contentDigest}`));
  if (success) {
    try {
      writeOpenClawSkillProvenance(receiptPath, {
        ...receiptIdentity,
        phase: "installed",
        contentDigest: snapshot.contentDigest,
        previousDigest: null,
        stageNonce: null,
      });
    } catch {
      return { success: false, uploaded: 0, reason: "provenance_finalization_failed" };
    }
    return {
      success: true,
      uploaded: snapshot.files.length,
      contentDigest: snapshot.contentDigest,
    };
  }
  if (
    (result?.status === 2 && stdout.endsWith("COLLISION")) ||
    (result?.status === 3 && stdout.endsWith("CAPABILITY_MISSING")) ||
    (result?.status === 5 && stdout.endsWith("LEGACY_COLLISION")) ||
    (result?.status === 6 && stdout.endsWith("UPDATE_UNSUPPORTED")) ||
    (result?.status === 7 && stdout.endsWith("STAGE_COLLISION"))
  ) {
    try {
      restoreOpenClawSkillProvenance(receiptPath, priorReceipt);
    } catch {
      return { success: false, uploaded: 0, reason: "provenance_failed" };
    }
  }
  return {
    success: false,
    uploaded: 0,
    reason:
      result?.status === 2 && stdout.endsWith("COLLISION")
        ? "destination_exists"
        : result?.status === 5 && stdout.endsWith("LEGACY_COLLISION")
          ? "legacy_destination_exists"
          : result?.status === 3 && stdout.endsWith("CAPABILITY_MISSING")
            ? "native_capability_missing"
            : result?.status === 6 && stdout.endsWith("UPDATE_UNSUPPORTED")
              ? "update_unsupported"
              : result?.status === 7 && stdout.endsWith("STAGE_COLLISION")
                ? "staging_collision"
                : result?.status === 4 && stdout.endsWith("VERIFY_FAILED")
                  ? "verification_failed"
                  : "remote_state_unknown",
  };
}

/** Return activation guidance after a generic agent skill upload. */
export function postInstall(
  _ctx: SshContext,
  paths: SkillPaths,
  _localSkillDir: string,
  _opts: {
    skipRefresh?: boolean;
    sshExecImpl?: typeof sshExec;
  } = {},
): { success: boolean; messages: string[] } {
  return {
    success: true,
    messages: [
      paths.reloadsSkillsOnSessionStart
        ? "Start a new chat session to load the skill; a gateway restart is not required."
        : "Restart the agent gateway to pick up the new skill.",
    ],
  };
}

/** Verify the SKILL.md file exists at the generic agent upload destination. */
export function verifyInstall(
  ctx: SshContext,
  paths: SkillPaths,
  opts: { sshExecImpl?: typeof sshExec } = {},
): boolean {
  const runSsh = opts.sshExecImpl ?? sshExec;
  const result = runSsh(ctx, `test -f ${shellQuote(`${paths.uploadDir}/SKILL.md`)} && echo EXISTS`);
  return result !== null && result.stdout === "EXISTS";
}
