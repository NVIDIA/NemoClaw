// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  AgentStateDirectory,
  AgentStateDirectoryPath,
  AgentStateDirectoryShields,
  AgentStateLockPlan,
} from "./definition-types";

type UnknownRecord = Record<string, unknown>;

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const STATE_DIRECTORY_FIELDS = new Set([
  "path",
  "prefix",
  "backup",
  "shields",
  "writable_subpaths",
]);
const SAFE_LOCK_NAME_RE = /^[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCanonicalPath(value: string, field: string, allowWildcards = false): void {
  if (value.length === 0) {
    throw new Error(`Agent manifest field '${field}' must not be empty`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`Agent manifest field '${field}' must not contain control characters`);
  }
  if (value.startsWith("/")) {
    throw new Error(`Agent manifest field '${field}' must be a relative path, not absolute`);
  }
  if (value.includes("\\")) {
    throw new Error(`Agent manifest field '${field}' must use canonical forward slashes`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(
      `Agent manifest field '${field}' must be a canonical relative path without empty, '.', or '..' components`,
    );
  }
  if (segments.some((segment) => segment.includes("*") && (!allowWildcards || segment !== "*"))) {
    throw new Error(
      `Agent manifest field '${field}' may use '*' only as a complete path component`,
    );
  }
}

function readShields(value: unknown, field: string): AgentStateDirectoryShields | undefined {
  if (value === undefined) return undefined;
  if (value === "read-only" || value === "confidential") return value;
  throw new Error(`Agent manifest field '${field}' must be read-only or confidential`);
}

function readWritableSubpaths(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Agent manifest field '${field}' must be an array`);
  }
  const entries = value.map((entry, index) => {
    const entryField = `${field}[${String(index)}]`;
    if (typeof entry !== "string") {
      throw new Error(`Agent manifest field '${entryField}' must be a string`);
    }
    assertCanonicalPath(entry, entryField, true);
    if (entry.split("/").at(-1) === "*") {
      throw new Error(
        `Agent manifest field '${entryField}' must end with a literal directory name`,
      );
    }
    return entry;
  });
  if (new Set(entries).size !== entries.length) {
    throw new Error(`Agent manifest field '${field}' must not contain duplicates`);
  }
  return entries;
}

function readStateDirectory(entry: unknown, index: number): AgentStateDirectory {
  const field = `state_dirs[${String(index)}]`;
  if (typeof entry === "string") {
    assertCanonicalPath(entry, field);
    return { kind: "path", path: entry, backup: true, writableSubpaths: [] };
  }
  if (!isRecord(entry)) {
    throw new Error(`Agent manifest field '${field}' must be a string or object`);
  }
  for (const key of Object.keys(entry)) {
    if (!STATE_DIRECTORY_FIELDS.has(key)) {
      throw new Error(`Agent manifest field '${field}.${key}' is not allowed`);
    }
  }
  const path = entry.path;
  const prefix = entry.prefix;
  const hasPath = Object.hasOwn(entry, "path");
  const hasPrefix = Object.hasOwn(entry, "prefix");
  if (hasPath === hasPrefix) {
    throw new Error(`Agent manifest field '${field}' must declare exactly one of path or prefix`);
  }
  if (entry.backup !== undefined && typeof entry.backup !== "boolean") {
    throw new Error(`Agent manifest field '${field}.backup' must be a boolean`);
  }
  const backup = entry.backup !== false;
  const shields = readShields(entry.shields, `${field}.shields`);
  if (hasPath) {
    if (typeof path !== "string") {
      throw new Error(`Agent manifest field '${field}.path' must be a string`);
    }
    assertCanonicalPath(path, `${field}.path`);
    const writableSubpaths = readWritableSubpaths(
      entry.writable_subpaths,
      `${field}.writable_subpaths`,
    );
    if (writableSubpaths.length > 0 && shields !== "read-only") {
      throw new Error(
        `Agent manifest field '${field}.writable_subpaths' requires shields: read-only`,
      );
    }
    return {
      kind: "path",
      path,
      backup,
      ...(shields ? { shields } : {}),
      writableSubpaths,
    };
  }
  if (entry.writable_subpaths !== undefined) {
    throw new Error(`Agent manifest field '${field}.writable_subpaths' requires path`);
  }
  if (typeof prefix !== "string" || !SAFE_LOCK_NAME_RE.test(prefix)) {
    throw new Error(
      `Agent manifest field '${field}.prefix' must contain only letters, digits, '.', '_', or '-'`,
    );
  }
  return {
    kind: "prefix",
    prefix,
    backup,
    ...(shields ? { shields } : {}),
  };
}

export function readStateDirectories(record: UnknownRecord): AgentStateDirectory[] {
  const value = record.state_dirs;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Agent manifest field 'state_dirs' must be an array");
  }
  const directories = value.map(readStateDirectory);
  const seen = new Set<string>();
  for (const directory of directories) {
    const key = directory.kind === "path" ? `path:${directory.path}` : `prefix:${directory.prefix}`;
    if (seen.has(key)) {
      throw new Error(`Agent manifest field 'state_dirs' repeats ${key}`);
    }
    seen.add(key);
  }
  const declaredPaths = new Set(
    directories.filter((entry) => entry.kind === "path").map((entry) => entry.path),
  );
  for (const directory of directories) {
    if (directory.kind !== "prefix") continue;
    const sibling = directory.prefix.slice(0, -1);
    if (!directory.prefix.endsWith("-") || sibling.includes("/") || !declaredPaths.has(sibling)) {
      throw new Error(
        `Agent manifest field 'state_dirs' prefix '${directory.prefix}' must extend a declared top-level path with '-'`,
      );
    }
    const overlappingPath = directories.find(
      (entry) => entry.kind === "path" && topLevelPath(entry.path).startsWith(directory.prefix),
    );
    if (overlappingPath?.kind === "path") {
      throw new Error(
        `Agent manifest field 'state_dirs' prefix '${directory.prefix}' overlaps exact path '${overlappingPath.path}'`,
      );
    }
  }
  return directories;
}

function addPolicyRoot(
  roots: Map<string, AgentStateDirectoryShields>,
  root: string,
  shields: AgentStateDirectoryShields,
): void {
  const existing = roots.get(root);
  if (existing && existing !== shields) {
    throw new Error(`Agent state directory root '${root}' has conflicting Shields declarations`);
  }
  roots.set(root, shields);
}

function topLevelPath(value: string): string {
  const separator = value.indexOf("/");
  return separator === -1 ? value : value.slice(0, separator);
}

function writablePatternsOverlap(first: string, second: string): boolean {
  const firstComponents = first.split("/");
  const secondComponents = second.split("/");
  const sharedLength = Math.min(firstComponents.length, secondComponents.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const left = firstComponents[index];
    const right = secondComponents[index];
    if (left !== "*" && right !== "*" && left !== right) return false;
  }
  return true;
}

function validateStateLockPlan(plan: AgentStateLockPlan): void {
  const roots = [...plan.readOnlyRoots, ...plan.confidentialRoots];
  const prefixes = [...plan.readOnlyPrefixes, ...plan.confidentialPrefixes];
  for (const root of roots) {
    if (!SAFE_LOCK_NAME_RE.test(root)) {
      throw new Error(
        `Agent state directory root '${root}' cannot be represented by the Shields helper`,
      );
    }
    const matchingPrefix = prefixes.find((prefix) => root.startsWith(prefix));
    if (matchingPrefix) {
      throw new Error(
        `Agent state directory root '${root}' overlaps Shields prefix '${matchingPrefix}'`,
      );
    }
  }
  for (let index = 0; index < prefixes.length; index += 1) {
    const prefix = prefixes[index];
    for (const other of prefixes.slice(index + 1)) {
      if (prefix.startsWith(other) || other.startsWith(prefix)) {
        throw new Error(`Agent state directory prefixes '${prefix}' and '${other}' overlap`);
      }
    }
  }
  for (let index = 0; index < plan.writableSubpaths.length; index += 1) {
    const writable = plan.writableSubpaths[index];
    for (const other of plan.writableSubpaths.slice(index + 1)) {
      if (writablePatternsOverlap(writable, other)) {
        throw new Error(
          `Agent state directory writable subpaths '${writable}' and '${other}' overlap`,
        );
      }
    }
  }
}

export function buildStateLockPlan(
  directories: readonly AgentStateDirectory[],
): AgentStateLockPlan {
  const roots = new Map<string, AgentStateDirectoryShields>();
  const prefixes = new Map<string, AgentStateDirectoryShields>();
  const writableSubpaths: string[] = [];
  for (const directory of directories) {
    if (directory.kind === "prefix") {
      if (directory.shields) addPolicyRoot(prefixes, directory.prefix, directory.shields);
      continue;
    }
    if (directory.shields) {
      addPolicyRoot(roots, topLevelPath(directory.path), directory.shields);
    }
    for (const subpath of directory.writableSubpaths) {
      writableSubpaths.push(`${directory.path}/${subpath}`);
    }
  }

  const select = (
    values: Map<string, AgentStateDirectoryShields>,
    policy: AgentStateDirectoryShields,
  ): string[] =>
    [...values]
      .filter(([, value]) => value === policy)
      .map(([key]) => key)
      .sort();

  const plan: AgentStateLockPlan = {
    version: 1,
    readOnlyRoots: select(roots, "read-only"),
    confidentialRoots: select(roots, "confidential"),
    readOnlyPrefixes: select(prefixes, "read-only"),
    confidentialPrefixes: select(prefixes, "confidential"),
    writableSubpaths: [...new Set(writableSubpaths)].sort(),
  };
  validateStateLockPlan(plan);
  return plan;
}

export function stateDirectoryPaths(
  directories: readonly AgentStateDirectory[],
  options: { backup?: boolean } = {},
): string[] {
  return directories
    .filter((entry): entry is AgentStateDirectoryPath => entry.kind === "path")
    .filter((entry) => options.backup === undefined || entry.backup === options.backup)
    .map((entry) => entry.path);
}

export function stateDirectoryPrefixes(
  directories: readonly AgentStateDirectory[],
  options: { backup?: boolean } = {},
): string[] {
  return directories
    .filter((entry) => entry.kind === "prefix")
    .filter((entry) => options.backup === undefined || entry.backup === options.backup)
    .map((entry) => entry.prefix);
}
