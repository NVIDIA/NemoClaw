// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Stateless skill staging and canonical-root filesystem fallbacks. Agent
// discovery and activation always remain native-agent responsibilities.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { isObjectRecord } from "./core/json-types";
import { shellQuote } from "./core/shell-quote";
import { validateSkillName } from "./skill-name";

export { validateSkillName } from "./skill-name";

type FrontmatterScalar = string | number | boolean | null | undefined;
type FrontmatterValue = FrontmatterScalar | FrontmatterRecord | FrontmatterValue[];
type FrontmatterRecord = { [key: string]: FrontmatterValue };

export interface SkillFrontmatter {
  name: string;
}

export function parseFrontmatter(content: string): SkillFrontmatter {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error("SKILL.md is missing YAML frontmatter (no opening --- delimiter)");
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    throw new Error("SKILL.md is missing closing --- frontmatter delimiter");
  }

  let parsed: FrontmatterValue;
  try {
    parsed = YAML.parse(lines.slice(1, closingIndex).join("\n"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`SKILL.md frontmatter is not valid YAML: ${detail}`);
  }
  if (!isObjectRecord(parsed)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping (key: value pairs)");
  }
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) throw new Error("SKILL.md frontmatter is missing required 'name' field");
  if (!validateSkillName(name)) {
    throw new Error(
      `SKILL.md name '${name}' is invalid. Use [A-Za-z0-9._-] and do not use '.' or '..'.`,
    );
  }
  return { name };
}

const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._\-/]+$/u;

export function validateRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    SAFE_RELATIVE_PATH.test(relativePath) &&
    relativePath.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export interface CollectedSkillFiles {
  files: string[];
  fileIdentities: Record<string, SkillFileIdentity>;
  skippedDotfiles: string[];
  unsafePaths: string[];
  unsupportedPaths: string[];
}

interface SkillFileIdentity {
  dev: number;
  ino: number;
}

export function collectSkillFiles(root: string): CollectedSkillFiles {
  const result: CollectedSkillFiles = {
    files: [],
    fileIdentities: {},
    skippedDotfiles: [],
    unsafePaths: [],
    unsupportedPaths: [],
  };

  const walk = (directory: string, prefix: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const candidate = path.join(directory, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        result.unsupportedPaths.push(relativePath);
      } else if (!stat.isDirectory() && !stat.isFile()) {
        result.unsupportedPaths.push(relativePath);
      } else if (name.startsWith(".")) {
        result.skippedDotfiles.push(stat.isDirectory() ? `${relativePath}/` : relativePath);
      } else if (!validateRelativePath(relativePath)) {
        result.unsafePaths.push(relativePath);
      } else if (stat.isDirectory()) {
        walk(candidate, relativePath);
      } else if (stat.isFile()) {
        result.files.push(relativePath);
        result.fileIdentities[relativePath] = { dev: stat.dev, ino: stat.ino };
      }
    }
  };

  walk(root, "");
  result.files.sort();
  result.skippedDotfiles.sort();
  result.unsafePaths.sort();
  result.unsupportedPaths.sort();
  return result;
}

export const SKILL_SNAPSHOT_MAX_FILES = 1024;
export const SKILL_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

export interface SkillRootIdentity {
  dev: number;
  ino: number;
}

export type StatelessSkillSnapshot = Readonly<{
  files: readonly string[];
  hostDirectory: string;
  skillDirectory: string;
  skippedDotfiles: readonly string[];
  totalBytes: number;
  cleanup: () => void;
}>;

export type StatelessSkillSnapshotResult =
  | { success: true; snapshot: StatelessSkillSnapshot }
  | {
      success: false;
      reason: "invalid-tree" | "limit-exceeded" | "source-changed";
      paths?: readonly string[];
    };

function matchesRootIdentity(stat: fs.Stats, expected: SkillRootIdentity): boolean {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.dev === expected.dev &&
    stat.ino === expected.ino
  );
}

function pathMatchesRoot(root: string, candidate: string, relativePath: string): boolean {
  const observed = path.relative(root, candidate);
  return (
    observed === path.normalize(relativePath) &&
    !path.isAbsolute(observed) &&
    !observed.startsWith(`..${path.sep}`)
  );
}

function readBoundedFile(descriptor: number, remainingBytes: number): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, remainingBytes - total + 1));
    const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    if (total > remainingBytes) return null;
    chunks.push(chunk.subarray(0, count));
  }
}

/** Create a private, bounded snapshot using only no-follow regular-file reads. */
export function createStatelessSkillSnapshot(
  sourceDirectory: string,
  skillName: string,
  expectedRootIdentity: SkillRootIdentity,
): StatelessSkillSnapshotResult {
  let collected: CollectedSkillFiles;
  try {
    collected = collectSkillFiles(sourceDirectory);
  } catch {
    return { success: false, reason: "source-changed" };
  }
  const invalidPaths = [...collected.unsafePaths, ...collected.unsupportedPaths];
  if (invalidPaths.length > 0 || !collected.files.includes("SKILL.md")) {
    return { success: false, reason: "invalid-tree", paths: invalidPaths };
  }
  if (collected.files.length > SKILL_SNAPSHOT_MAX_FILES) {
    return { success: false, reason: "limit-exceeded" };
  }

  const hostDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-"));
  const snapshotDirectory = path.join(hostDirectory, skillName);
  let succeeded = false;
  try {
    fs.chmodSync(hostDirectory, 0o700);
    fs.mkdirSync(snapshotDirectory, { mode: 0o700 });
    const rootStat = fs.lstatSync(sourceDirectory);
    const sourceRoot = fs.realpathSync(sourceDirectory);
    if (!matchesRootIdentity(rootStat, expectedRootIdentity)) {
      return { success: false, reason: "source-changed" };
    }
    if (!matchesRootIdentity(fs.lstatSync(sourceRoot), expectedRootIdentity)) {
      return { success: false, reason: "source-changed" };
    }

    let totalBytes = 0;
    for (const relativePath of collected.files) {
      const source = path.join(sourceRoot, relativePath);
      const enumerated = collected.fileIdentities[relativePath];
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(
          source,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        const opened = fs.fstatSync(descriptor);
        if (
          !enumerated ||
          !opened.isFile() ||
          opened.dev !== enumerated.dev ||
          opened.ino !== enumerated.ino
        ) {
          return { success: false, reason: "source-changed" };
        }
        if (opened.size > SKILL_SNAPSHOT_MAX_BYTES - totalBytes) {
          return { success: false, reason: "limit-exceeded" };
        }
        const content = readBoundedFile(descriptor, SKILL_SNAPSHOT_MAX_BYTES - totalBytes);
        if (!content) return { success: false, reason: "limit-exceeded" };
        const after = fs.lstatSync(source);
        if (
          !after.isFile() ||
          after.isSymbolicLink() ||
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          !pathMatchesRoot(sourceRoot, fs.realpathSync(source), relativePath)
        ) {
          return { success: false, reason: "source-changed" };
        }
        const destination = path.join(snapshotDirectory, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
        fs.writeFileSync(destination, content, {
          flag: "wx",
          mode: (opened.mode & 0o111) === 0 ? 0o644 : 0o755,
        });
        totalBytes += content.length;
      } catch {
        return { success: false, reason: "source-changed" };
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    }

    const snapshotFiles = collectSkillFiles(snapshotDirectory);
    if (
      snapshotFiles.unsafePaths.length > 0 ||
      snapshotFiles.unsupportedPaths.length > 0 ||
      snapshotFiles.files.join("\n") !== collected.files.join("\n") ||
      parseFrontmatter(fs.readFileSync(path.join(snapshotDirectory, "SKILL.md"), "utf8")).name !==
        skillName
    ) {
      return { success: false, reason: "source-changed" };
    }
    let cleaned = false;
    succeeded = true;
    return {
      success: true,
      snapshot: {
        files: Object.freeze([...collected.files]),
        hostDirectory,
        skillDirectory: snapshotDirectory,
        skippedDotfiles: Object.freeze([...collected.skippedDotfiles]),
        totalBytes,
        cleanup: () => {
          if (cleaned) return;
          cleaned = true;
          fs.rmSync(hostDirectory, { force: true, recursive: true });
        },
      },
    };
  } catch {
    return { success: false, reason: "source-changed" };
  } finally {
    if (!succeeded) fs.rmSync(hostDirectory, { force: true, recursive: true });
  }
}

const PRIVATE_STAGE_PATTERN = /^\/sandbox\/[.]nemoclaw-skill-stage[.][a-f0-9]{32}$/u;

export function buildPrepareSkillStageCommand(stageDirectory: string): string {
  if (!PRIVATE_STAGE_PATTERN.test(stageDirectory))
    throw new Error("Invalid private skill staging path");
  return [
    "set -eu",
    `stage=${shellQuote(stageDirectory)}`,
    '[ -d /sandbox ] && [ ! -L /sandbox ] && [ "$(realpath -e -- /sandbox)" = /sandbox ]',
    '[ ! -e "$stage" ] && [ ! -L "$stage" ]',
    'mkdir -- "$stage"',
    'chmod 700 "$stage"',
  ].join("; ");
}

export function buildCleanupSkillStageCommand(stageDirectory: string): string {
  if (!PRIVATE_STAGE_PATTERN.test(stageDirectory))
    throw new Error("Invalid private skill staging path");
  return [
    "set -eu",
    `stage=${shellQuote(stageDirectory)}`,
    '[ ! -L "$stage" ]',
    'rm -rf -- "$stage"',
  ].join("; ");
}

function canonicalRootCreationCommands(writableRoot: string): string[] {
  assertCanonicalSkillRoot(writableRoot);
  const parts = writableRoot.slice("/sandbox/".length).split("/");
  const commands = [
    '[ -d /sandbox ] && [ ! -L /sandbox ] && [ "$(realpath -e -- /sandbox)" = /sandbox ]',
    "cd -P -- /sandbox",
  ];
  let expected = "/sandbox";
  for (const part of parts) {
    expected = `${expected}/${part}`;
    commands.push(
      `part=${shellQuote(part)}`,
      '[ ! -L "$part" ]',
      'if [ ! -e "$part" ]; then mkdir -- "$part"; chmod 700 "$part"; fi',
      '[ -d "$part" ] && [ ! -L "$part" ]',
      'cd -P -- "$part"',
      `[ "$(pwd -P)" = ${shellQuote(expected)} ]`,
    );
  }
  return commands;
}

function assertCanonicalSkillRoot(writableRoot: string): void {
  if (
    writableRoot !== path.posix.normalize(writableRoot) ||
    !writableRoot.startsWith("/sandbox/") ||
    writableRoot.endsWith("/") ||
    writableRoot
      .slice("/sandbox/".length)
      .split("/")
      .some((part) => !/^[A-Za-z0-9._-]+$/u.test(part) || part === "." || part === "..")
  ) {
    throw new Error("Invalid canonical writable skill root");
  }
}

/** Place one snapshot in only the declared canonical writable root. */
export function buildCanonicalSkillAddCommand(
  writableRoot: string,
  skillName: string,
  stagedSkillDirectory: string,
): string[] {
  if (!validateSkillName(skillName)) throw new Error("Invalid skill name");
  if (!stagedSkillDirectory.endsWith(`/${skillName}`)) throw new Error("Invalid staged skill path");
  return [
    "/bin/sh",
    "-c",
    [
      "set -eu",
      `root=${shellQuote(writableRoot)}`,
      `source=${shellQuote(stagedSkillDirectory)}`,
      `name=${shellQuote(skillName)}`,
      ...canonicalRootCreationCommands(writableRoot),
      '[ "$(pwd -P)" = "$root" ]',
      '[ -d "$source" ] && [ ! -L "$source" ] && [ "$(realpath -e -- "$source")" = "$source" ]',
      '[ -z "$(find "$source" -mindepth 1 ! -type d ! -type f -print -quit)" ]',
      'destination="$name"',
      'if [ -e "$destination" ] || [ -L "$destination" ]; then printf "Refusing to replace existing %s in the canonical writable skill root. Native skill list remains authoritative.\\n" "$name" >&2; exit 1; fi',
      'temporary="$(mktemp -d "$root/.nemoclaw-skill-add.$name.XXXXXX")"',
      'cleanup() { if [ -n "${temporary:-}" ] && [ -d "$temporary" ] && [ ! -L "$temporary" ]; then rm -rf -- "$temporary"; fi; }',
      "trap cleanup EXIT HUP INT TERM",
      'cp -a -- "$source/." "$temporary/"',
      '[ -z "$(find "$temporary" -mindepth 1 ! -type d ! -type f -print -quit)" ]',
      'mv -T -- "$temporary" "$destination"',
      'temporary=""',
      'printf "Placed %s in the canonical writable skill root. Native skill list and new sessions remain authoritative.\\n" "$name"',
    ].join("; "),
  ];
}

/** Delete only one named copy from the declared canonical writable root. */
export function buildCanonicalSkillRemoveCommand(
  writableRoot: string,
  skillName: string,
): string[] {
  if (!validateSkillName(skillName)) throw new Error("Invalid skill name");
  assertCanonicalSkillRoot(writableRoot);
  return [
    "/bin/sh",
    "-c",
    [
      "set -eu",
      `root=${shellQuote(writableRoot)}`,
      `name=${shellQuote(skillName)}`,
      'if [ ! -e "$root" ] && [ ! -L "$root" ]; then printf "No %s copy exists in the canonical writable skill root. Native skill list remains authoritative.\\n" "$name"; exit 0; fi',
      '[ -d "$root" ] && [ ! -L "$root" ] && [ "$(realpath -e -- "$root")" = "$root" ]',
      'cd -P -- "$root"',
      '[ "$(pwd -P)" = "$root" ]',
      'destination="$name"',
      'expected_destination="$root/$name"',
      'if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then printf "No %s copy exists in the canonical writable skill root. Native skill list remains authoritative.\\n" "$name"; exit 0; fi',
      '[ -d "$destination" ] && [ ! -L "$destination" ] && [ "$(realpath -e -- "$destination")" = "$expected_destination" ]',
      'rm -rf -- "$destination"',
      'printf "Removed %s only from the canonical writable skill root. Native skill list remains authoritative.\\n" "$name"',
    ].join("; "),
  ];
}
