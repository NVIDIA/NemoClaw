// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Skill install logic for `nemoclaw <sandbox> skill install <path>`.
// Validates local SKILL.md content and applies the selected agent's install
// contract. Every supported agent publishes through its own native lifecycle
// command after secure staging; NemoClaw owns no skill destination or registry.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// yaml is a production dependency (used by policies.ts, onboard.ts)
import YAML from "yaml";

import type { AgentDefinition } from "./agent/definition-types";
import { isObjectRecord } from "./core/json-types";
import { validateSkillName } from "./skill-name";
import type { SshContext } from "./skill-remote";
import { shellQuote, sshExec } from "./skill-remote";

export { validateSkillName } from "./skill-name";
export { type SshContext, type SshResult, shellQuote, sshExec } from "./skill-remote";

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

export interface NativeSkillState {
  /** Agent-owned root used only to bound private staging and returned native paths. */
  stateDir: string;
}

/** Resolve no skill destination; the native agent command owns that decision. */
export function resolveNativeSkillState(
  agent: { name: string; configPaths: { dir: string } } | null,
): NativeSkillState {
  return {
    stateDir: agent ? agent.configPaths.dir : "/sandbox/.openclaw",
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

const SHA256_RE = /^[a-f0-9]{64}$/;
const SKILL_SNAPSHOT_TIMEOUT_MS = 30_000;
export const SKILL_SNAPSHOT_MAX_FILES = 1024;
export const SKILL_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const OPENCLAW_REMOVE_HELP_EVIDENCE = "Remove a skill from the active agent workspace";

export type NativeSkillAgent = "hermes" | "langchain-deepagents-code" | "openclaw";

export interface NativeSkillLifecycleDescriptor {
  readonly agentName: NativeSkillAgent;
  readonly binary: string;
  readonly displayName: string;
  readonly fixedAgentTarget: string | null;
  readonly installHelpArgs: readonly string[];
  readonly installRequiredFlags: readonly string[];
  readonly removeHelpArgs?: readonly string[];
  readonly removeHelpEvidence?: string;
  install(payloadPath: string, skillName: string, expectedDigest: string): string[];
  list(extraArgs?: readonly string[]): string[];
  remove(skillName: string): string[];
}

type NativeSkillLifecycleCommandContract = Omit<
  NativeSkillLifecycleDescriptor,
  "binary" | "displayName" | "install" | "list" | "remove"
> & {
  install(binary: string, payloadPath: string, skillName: string, expectedDigest: string): string[];
  list(binary: string, extraArgs?: readonly string[]): string[];
  remove(binary: string, skillName: string): string[];
};

const NATIVE_SKILL_LIFECYCLES: Readonly<
  Record<NativeSkillAgent, NativeSkillLifecycleCommandContract>
> = {
  openclaw: {
    agentName: "openclaw",
    fixedAgentTarget: "main",
    installHelpArgs: ["skills", "install", "--help"],
    installRequiredFlags: ["--agent", "--force", "--expected-digest"],
    removeHelpArgs: ["skills", "remove", "--help"],
    removeHelpEvidence: OPENCLAW_REMOVE_HELP_EVIDENCE,
    install(binary, payloadPath, _skillName, expectedDigest) {
      return [
        binary,
        "skills",
        "install",
        payloadPath,
        "--agent",
        this.fixedAgentTarget!,
        "--force",
        "--expected-digest",
        expectedDigest,
      ];
    },
    list(binary, extraArgs = []) {
      return [binary, "skills", "list", "--agent", this.fixedAgentTarget!, ...extraArgs];
    },
    remove(binary, skillName) {
      return [binary, "skills", "remove", skillName, "--agent", this.fixedAgentTarget!];
    },
  },
  hermes: {
    agentName: "hermes",
    fixedAgentTarget: null,
    installHelpArgs: ["skills", "import-local", "--help"],
    installRequiredFlags: ["--name", "--expected-digest"],
    install(binary, payloadPath, skillName, expectedDigest) {
      return [
        binary,
        "skills",
        "import-local",
        payloadPath,
        "--name",
        skillName,
        "--expected-digest",
        expectedDigest,
      ];
    },
    list(binary, extraArgs = []) {
      return [binary, "skills", "list", ...extraArgs];
    },
    remove(binary, skillName) {
      return [binary, "skills", "uninstall", skillName, "--yes"];
    },
  },
  "langchain-deepagents-code": {
    agentName: "langchain-deepagents-code",
    fixedAgentTarget: "agent",
    installHelpArgs: ["skills", "import", "--help"],
    installRequiredFlags: ["--name", "--agent", "--replace", "--expected-digest"],
    install(binary, payloadPath, skillName, expectedDigest) {
      return [
        binary,
        "skills",
        "import",
        payloadPath,
        "--name",
        skillName,
        "--agent",
        this.fixedAgentTarget!,
        "--replace",
        "--expected-digest",
        expectedDigest,
      ];
    },
    list(binary, extraArgs = []) {
      return [binary, "skills", "list", "--agent", this.fixedAgentTarget!, ...extraArgs];
    },
    remove(binary, skillName) {
      return [
        binary,
        "skills",
        "delete",
        skillName,
        "--agent",
        this.fixedAgentTarget!,
        "--force",
        "--json",
      ];
    },
  },
};

type NativeSkillLifecycleAgentDefinition = Pick<
  AgentDefinition,
  "binary_path" | "displayName" | "name"
>;

/**
 * Bind native skill verbs to the executable owned by the selected agent manifest.
 * This descriptor never provides a fallback binary or display name.
 */
export function getNativeSkillLifecycle(
  agent: NativeSkillLifecycleAgentDefinition | null | undefined,
): NativeSkillLifecycleDescriptor | null {
  if (!agent || !(agent.name in NATIVE_SKILL_LIFECYCLES)) return null;
  const binary = agent.binary_path;
  if (typeof binary !== "string" || binary.trim() !== binary || !path.posix.isAbsolute(binary)) {
    return null;
  }
  const contract = NATIVE_SKILL_LIFECYCLES[agent.name as NativeSkillAgent];
  return {
    agentName: contract.agentName,
    binary,
    displayName: agent.displayName,
    fixedAgentTarget: contract.fixedAgentTarget,
    installHelpArgs: contract.installHelpArgs,
    installRequiredFlags: contract.installRequiredFlags,
    removeHelpArgs: contract.removeHelpArgs,
    removeHelpEvidence: contract.removeHelpEvidence,
    install: (payloadPath, skillName, expectedDigest) =>
      contract.install(binary, payloadPath, skillName, expectedDigest),
    list: (extraArgs = []) => contract.list(binary, extraArgs),
    remove: (skillName) => contract.remove(binary, skillName),
  };
}

function renderNativeSkillCommand(command: readonly string[], payloadToken?: string): string {
  return command
    .map((argument) => (argument === payloadToken ? '"$payload"' : shellQuote(argument)))
    .join(" ");
}

/** Probe the pinned native removal capability without mutating agent state. */
export function probeOpenClawSkillRemoveCapability(
  ctx: SshContext,
  expectedSandboxIdentityFingerprint: string,
  lifecycle: NativeSkillLifecycleDescriptor,
  sshExecImpl: typeof sshExec = sshExec,
): boolean {
  if (!SHA256_RE.test(expectedSandboxIdentityFingerprint)) return false;
  if (
    lifecycle.agentName !== "openclaw" ||
    !lifecycle.removeHelpArgs ||
    !lifecycle.removeHelpEvidence
  ) {
    return false;
  }
  const identityCheck = sandboxIdentityCheckCommand(expectedSandboxIdentityFingerprint);
  const script = [
    "set -eu",
    `${identityCheck} || exit 9`,
    `help="$(${[lifecycle.binary, ...lifecycle.removeHelpArgs].map(shellQuote).join(" ")} 2>&1)"`,
    `printf '%s' "$help" | grep -Fq ${shellQuote(lifecycle.removeHelpEvidence)}`,
    `${identityCheck} || exit 9`,
  ].join("; ");
  return sshExecImpl(ctx, script, { timeout: 30_000 })?.status === 0;
}

function sandboxIdentityCheckCommand(expectedFingerprint: string): string {
  const check = [
    'const crypto=require("node:crypto");',
    "const expected=process.argv[1];",
    'const id=process.env.OPENSHELL_SANDBOX_ID||"";',
    'if(!/^[A-Za-z0-9._-]{1,512}$/.test(id)||crypto.createHash("sha256").update(id).digest("hex")!==expected)process.exit(1);',
  ].join("");
  return `node -e ${shellQuote(check)} ${shellQuote(expectedFingerprint)}`;
}

/** Prefix one fixed native lifecycle command with an in-sandbox identity guard. */
export function bindNativeSkillCommandToSandboxIdentity(
  command: readonly string[],
  expectedFingerprint: string,
  timeout?: { diagnostic: string; seconds: number },
): string[] {
  if (command.length === 0 || !SHA256_RE.test(expectedFingerprint)) {
    throw new Error("Native skill command requires a valid sandbox identity binding");
  }
  const nativeCommand = command.map((argument) => shellQuote(argument)).join(" ");
  if (
    timeout &&
    (!Number.isSafeInteger(timeout.seconds) ||
      timeout.seconds < 1 ||
      timeout.diagnostic.length === 0)
  ) {
    throw new Error("Native skill command timeout binding is invalid");
  }
  const invocation = timeout
    ? `if timeout --signal=TERM --kill-after=5s ${String(timeout.seconds)}s ${nativeCommand}; then exit 0; else status=$?; if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then printf '%s\\n' ${shellQuote(timeout.diagnostic)} >&2; fi; exit "$status"; fi`
    : `exec ${nativeCommand}`;
  return [
    "/bin/sh",
    "-c",
    `${sandboxIdentityCheckCommand(expectedFingerprint)} || { echo IDENTITY_CHANGED >&2; exit 9; }; ${invocation}`,
  ];
}

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

export interface NativeSkillInstallResult {
  success: boolean;
  uploaded: number;
  contentDigest?: string;
  reason?:
    | "native_capability_missing"
    | "native_install_failed"
    | "native_install_timed_out"
    | "remote_state_unknown"
    | "sandbox_identity_changed"
    | "snapshot_failed"
    | "snapshot_limit_exceeded"
    | "stage_recovery_failed"
    | "verification_failed";
}

const NATIVE_STAGE_RECOVERY_COMMANDS = [
  'stage_recovery_failed() { echo "Unresolved abandoned skill staging path: $1. Inspect and remove it inside the sandbox before retrying." >&2; echo STAGE_RECOVERY_FAILED; exit 7; }',
  'for candidate in "$root"/.nemoclaw-skill-stage "$root"/.nemoclaw-skill-stage.*; do [ -e "$candidate" ] || [ -L "$candidate" ] || continue; stage_recovery_failed "$candidate"; done',
] as const;

const NATIVE_SKILL_INSTALL_TIMEOUT_SECONDS = 90;
const NATIVE_SKILL_VERIFICATION_TIMEOUT_SECONDS = 5;

interface NativeSkillStagingScriptOptions {
  paths: NativeSkillState;
  skillName: string;
  expectedDigest: string;
  expectedSandboxIdentityFingerprint: string;
  preStageCommands: readonly string[];
  lifecycleCommands: readonly string[];
  digestExcludedRelativePath?: string;
}

/** Emit the one private staging, cleanup, digest, and identity contract for every native agent. */
function buildNativeSkillStagingScript(options: NativeSkillStagingScriptOptions): string {
  const identityCheck = sandboxIdentityCheckCommand(options.expectedSandboxIdentityFingerprint);
  const fileSelection = options.digestExcludedRelativePath
    ? `find "$tree" -type f -printf "%P\\n" | LC_ALL=C sort | grep -Fxv ${shellQuote(options.digestExcludedRelativePath)} > "$manifest.files"`
    : 'find "$tree" -type f -printf "%P\\n" | LC_ALL=C sort > "$manifest.files"';
  return [
    "set -eu",
    "umask 077",
    `root=${shellQuote(options.paths.stateDir)}`,
    `skill=${shellQuote(options.skillName)}`,
    `expected=${shellQuote(options.expectedDigest)}`,
    'safe_tree() { [ -d "$1" ] && [ ! -L "$1" ] && [ -z "$(find "$1" -mindepth 1 ! -type d ! -type f -print -quit)" ]; }',
    `digest_tree() { tree="$1"; manifest="$2"; ${fileSelection}; : > "$manifest"; while IFS= read -r rel; do if [ -n "$(find "$tree/$rel" -type f -perm /111 -print -quit)" ]; then mode=755; else mode=644; fi; hash="$(sha256sum "$tree/$rel" | cut -d " " -f 1)"; printf "%s %s  %s\\n" "$mode" "$hash" "$rel" >> "$manifest"; done < "$manifest.files"; sha256sum "$manifest" | cut -d " " -f 1; }`,
    '[ -d "$root" ] && [ ! -L "$root" ] && [ "$(realpath -e -- "$root")" = "$root" ]',
    `${identityCheck} || { echo IDENTITY_CHANGED; exit 9; }`,
    ...options.preStageCommands,
    ...NATIVE_STAGE_RECOVERY_COMMANDS,
    'stage="$(mktemp -d "$root/.nemoclaw-skill-stage.XXXXXX")"',
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
    ...options.lifecycleCommands,
    `${identityCheck} || { echo IDENTITY_CHANGED; exit 9; }`,
    'printf "INSTALLED %s\\n" "$installed"',
  ].join("; ");
}

/** Bound the agent-owned publisher below the outer SSH timeout so cleanup always completes first. */
function buildBoundedNativeSkillInstallCommand(
  invocation: string,
  capturedOutput?: string,
): string {
  const command = capturedOutput ? `${invocation} > ${capturedOutput} 2>&1` : invocation;
  const replay = capturedOutput ? `cat ${capturedOutput} >&2; ` : "";
  return `if timeout --signal=TERM --kill-after=5s ${NATIVE_SKILL_INSTALL_TIMEOUT_SECONDS}s ${command}; then :; else native_status=$?; ${replay}if [ "$native_status" -eq 124 ] || [ "$native_status" -eq 137 ]; then echo "Native skill installation timed out; inspect native skill list state before retrying." >&2; echo NATIVE_INSTALL_TIMEOUT; exit 6; fi; echo NATIVE_INSTALL_FAILED; exit 5; fi`;
}

function buildBoundedNativeSkillVerificationCommand(
  invocation: string,
  operation: string,
  outputFile: string,
): string {
  return `if timeout --signal=TERM --kill-after=1s ${NATIVE_SKILL_VERIFICATION_TIMEOUT_SECONDS}s ${invocation} > ${outputFile}; then :; else echo "Native skill verification failed during ${operation}; inspect native skill list state before retrying." >&2; echo VERIFY_FAILED; exit 4; fi`;
}

function buildOpenClawNativeInstallScript(
  paths: NativeSkillState,
  lifecycle: NativeSkillLifecycleDescriptor,
  skillName: string,
  expectedDigest: string,
  expectedSandboxIdentityFingerprint: string,
): string {
  if (lifecycle.agentName !== "openclaw") {
    throw new Error("OpenClaw native install requires the OpenClaw lifecycle contract");
  }
  const fixedAgentTarget = lifecycle.fixedAgentTarget;
  if (!fixedAgentTarget) throw new Error("OpenClaw native install requires a fixed agent target");
  const stageToken = "__NEMOCLAW_PAYLOAD__";
  const installCommand = renderNativeSkillCommand(
    lifecycle.install(stageToken, skillName, expectedDigest),
    stageToken,
  );
  const verifyNativeJson = [
    'const fs=require("node:fs");',
    'const path=require("node:path");',
    "const [listPath,infoPath,checkPath,skill,stateRoot]=process.argv.slice(1);",
    'const read=(file)=>JSON.parse(fs.readFileSync(file,"utf8"));',
    "const list=read(listPath);const info=read(infoPath);const check=read(checkPath);",
    'const listed=Array.isArray(list.skills)&&list.skills.some((entry)=>entry&&typeof entry==="object"&&entry.name===skill);',
    'const baseDir=info&&typeof info==="object"&&typeof info.baseDir==="string"?info.baseDir:info&&typeof info.filePath==="string"?path.dirname(info.filePath):"";',
    'const target=path.resolve(baseDir);const relative=path.relative(path.resolve(stateRoot),target);const segments=relative.split(path.sep);const workspace=segments[0]||"";',
    'const bounded=segments.length===3&&(workspace==="workspace"||/^workspace-[A-Za-z0-9._-]+$/.test(workspace))&&segments[1]==="skills"&&segments[2]===skill&&!path.isAbsolute(relative)&&!relative.startsWith(".."+path.sep);',
    'const informed=bounded&&info&&typeof info==="object"&&info.name===skill&&(info.filePath===undefined||path.resolve(info.filePath)===path.resolve(target,"SKILL.md"));',
    'const checked=check&&typeof check==="object"&&check.agentId==="main"&&Array.isArray(check.eligible)&&check.eligible.includes(skill);',
    "if(!listed||!informed||!checked)process.exit(1);process.stdout.write(target);",
  ].join("");
  // The pinned native installer owns source-origin metadata and may recreate
  // payload modes under umask; hash only payload files with normalized modes.
  return buildNativeSkillStagingScript({
    paths,
    skillName,
    expectedDigest,
    expectedSandboxIdentityFingerprint,
    digestExcludedRelativePath: ".openclaw/source-origin.json",
    preStageCommands: [
      `help="$(${renderNativeSkillCommand([lifecycle.binary, ...lifecycle.installHelpArgs])} 2>&1)" || { echo CAPABILITY_MISSING; exit 3; }`,
      ...lifecycle.installRequiredFlags.map(
        (flag) =>
          `printf "%s" "$help" | grep -q -- ${shellQuote(flag)} || { echo CAPABILITY_MISSING; exit 3; }`,
      ),
    ],
    lifecycleCommands: [
      buildBoundedNativeSkillInstallCommand(installCommand),
      buildBoundedNativeSkillVerificationCommand(
        renderNativeSkillCommand(lifecycle.list(["--json"])),
        "skills list",
        '"$stage/list.json"',
      ),
      buildBoundedNativeSkillVerificationCommand(
        renderNativeSkillCommand([
          lifecycle.binary,
          "skills",
          "info",
          skillName,
          "--agent",
          fixedAgentTarget,
          "--json",
        ]),
        "skills info",
        '"$stage/info.json"',
      ),
      buildBoundedNativeSkillVerificationCommand(
        renderNativeSkillCommand([
          lifecycle.binary,
          "skills",
          "check",
          "--agent",
          fixedAgentTarget,
          "--json",
        ]),
        "skills check",
        '"$stage/check.json"',
      ),
      `target="$(node -e ${shellQuote(verifyNativeJson)} "$stage/list.json" "$stage/info.json" "$stage/check.json" "$skill" "$root")" || { echo VERIFY_FAILED; exit 4; }`,
      'target_real="$(realpath -e -- "$target")" || { echo VERIFY_FAILED; exit 4; }',
      '[ "$target_real" = "$target" ] || { echo VERIFY_FAILED; exit 4; }',
      'safe_tree "$target_real" || { echo VERIFY_FAILED; exit 4; }',
      'installed="$(digest_tree "$target_real" "$stage/installed.manifest")"',
      '[ "$installed" = "$expected" ] || { echo VERIFY_FAILED; exit 4; }',
    ],
  });
}

type NativeSkillInstallOptions = SkillSnapshotOptions & {
  expectedSandboxIdentityFingerprint: string;
  sshExecImpl?: typeof sshExec;
};

const NATIVE_SKILL_FAILURES: readonly {
  reason: NonNullable<NativeSkillInstallResult["reason"]>;
  status: number;
  suffix: string;
}[] = [
  { status: 3, suffix: "CAPABILITY_MISSING", reason: "native_capability_missing" },
  { status: 4, suffix: "VERIFY_FAILED", reason: "verification_failed" },
  { status: 5, suffix: "NATIVE_INSTALL_FAILED", reason: "native_install_failed" },
  { status: 6, suffix: "NATIVE_INSTALL_TIMEOUT", reason: "native_install_timed_out" },
  { status: 7, suffix: "STAGE_RECOVERY_FAILED", reason: "stage_recovery_failed" },
  { status: 9, suffix: "IDENTITY_CHANGED", reason: "sandbox_identity_changed" },
];

/** Own the snapshot, identity, transport, success, and failure contract for every native agent. */
function executeNativeSkillInstall(
  ctx: SshContext,
  localDir: string,
  skillName: string,
  opts: NativeSkillInstallOptions,
  buildScript: (expectedDigest: string) => string,
): NativeSkillInstallResult {
  const snapshot = prepareSkillArchiveSnapshot(localDir, opts);
  if (snapshot === "limit_exceeded") {
    return { success: false, uploaded: 0, reason: "snapshot_limit_exceeded" };
  }
  if (!snapshot || snapshot.skillName !== skillName) {
    return { success: false, uploaded: 0, reason: "snapshot_failed" };
  }
  if (!SHA256_RE.test(opts.expectedSandboxIdentityFingerprint)) {
    return { success: false, uploaded: 0, reason: "sandbox_identity_changed" };
  }
  const result = (opts.sshExecImpl ?? sshExec)(ctx, buildScript(snapshot.contentDigest), {
    input: snapshot.archive,
    timeout: 120_000,
  });
  const stdout = result?.stdout.trim() ?? "";
  if (result?.status === 0 && stdout.endsWith(`INSTALLED ${snapshot.contentDigest}`)) {
    return {
      success: true,
      uploaded: snapshot.files.length,
      contentDigest: snapshot.contentDigest,
    };
  }
  const failure = NATIVE_SKILL_FAILURES.find(
    ({ status, suffix }) => result?.status === status && stdout.endsWith(suffix),
  );
  return {
    success: false,
    uploaded: 0,
    reason: failure?.reason ?? "remote_state_unknown",
  };
}

/**
 * Securely stage a host snapshot and delegate OpenClaw workspace publication,
 * rollback, precedence, and activation to the pinned native installer.
 */
export function installOpenClawSkill(
  ctx: SshContext,
  localDir: string,
  paths: NativeSkillState,
  skillName: string,
  opts: NativeSkillInstallOptions & {
    lifecycle: NativeSkillLifecycleDescriptor;
  },
): NativeSkillInstallResult {
  return executeNativeSkillInstall(ctx, localDir, skillName, opts, (expectedDigest) =>
    buildOpenClawNativeInstallScript(
      paths,
      opts.lifecycle,
      skillName,
      expectedDigest,
      opts.expectedSandboxIdentityFingerprint,
    ),
  );
}

export type NativeLocalSkillAgent = Exclude<NativeSkillAgent, "openclaw">;

/** Build a secure staging wrapper around an agent's native local import command. */
function buildNativeLocalSkillInstallScript(
  paths: NativeSkillState,
  lifecycle: NativeSkillLifecycleDescriptor,
  skillName: string,
  expectedDigest: string,
  expectedSandboxIdentityFingerprint: string,
): string {
  const stageToken = "__NEMOCLAW_PAYLOAD__";
  if (lifecycle.agentName === "openclaw") {
    throw new Error("Native local skill install requires a non-OpenClaw lifecycle contract");
  }
  const nativeResultParser = [
    'const fs=require("node:fs");',
    'const path=require("node:path");',
    "const [file,expectedName,expectedDigest,stateRoot]=process.argv.slice(1);",
    'const prefix="NEMOCLAW_NATIVE_SKILL_IMPORT=";',
    'const lines=fs.readFileSync(file,"utf8").split(/\\r?\\n/).filter((line)=>line.startsWith(prefix));',
    "if(lines.length!==1)process.exit(1);",
    "const value=JSON.parse(lines[0].slice(prefix.length));",
    'if(!value||value.status!=="installed"||value.name!==expectedName||value.digest!==expectedDigest||typeof value.path!=="string"||!path.isAbsolute(value.path)||path.basename(value.path)!==expectedName)process.exit(1);',
    "const relative=path.relative(stateRoot,value.path);",
    'if(!relative||relative.startsWith(".."+path.sep)||path.isAbsolute(relative))process.exit(1);',
    "process.stdout.write(path.resolve(value.path));",
  ].join("");
  const commandArgs = renderNativeSkillCommand(
    lifecycle.install(stageToken, skillName, expectedDigest),
    stageToken,
  );
  return buildNativeSkillStagingScript({
    paths,
    skillName,
    expectedDigest,
    expectedSandboxIdentityFingerprint,
    preStageCommands: [
      `help="$(${renderNativeSkillCommand([lifecycle.binary, ...lifecycle.installHelpArgs])} 2>&1)" || { echo CAPABILITY_MISSING; exit 3; }`,
      ...lifecycle.installRequiredFlags.map(
        (flag) =>
          `printf "%s" "$help" | grep -q -- ${shellQuote(flag)} || { echo CAPABILITY_MISSING; exit 3; }`,
      ),
    ],
    lifecycleCommands: [
      buildBoundedNativeSkillInstallCommand(commandArgs, '"$stage/native.out"'),
      `target="$(node -e ${shellQuote(nativeResultParser)} "$stage/native.out" "$skill" "$expected" "$root")" || { cat "$stage/native.out" >&2; echo VERIFY_FAILED; exit 4; }`,
      'target_real="$(realpath -e -- "$target")" || { echo VERIFY_FAILED; exit 4; }',
      'case "$target_real" in "$root"/*) ;; *) echo VERIFY_FAILED; exit 4 ;; esac',
      'safe_tree "$target_real" || { echo VERIFY_FAILED; exit 4; }',
      'installed="$(digest_tree "$target_real" "$stage/installed.manifest")"',
      '[ "$installed" = "$expected" ] || { echo VERIFY_FAILED; exit 4; }',
    ],
  });
}

/** Securely stage a host snapshot and delegate publication to Hermes or DCode. */
export function installNativeAgentSkill(
  ctx: SshContext,
  localDir: string,
  paths: NativeSkillState,
  lifecycle: NativeSkillLifecycleDescriptor,
  skillName: string,
  opts: NativeSkillInstallOptions,
): NativeSkillInstallResult {
  return executeNativeSkillInstall(ctx, localDir, skillName, opts, (expectedDigest) =>
    buildNativeLocalSkillInstallScript(
      paths,
      lifecycle,
      skillName,
      expectedDigest,
      opts.expectedSandboxIdentityFingerprint,
    ),
  );
}
