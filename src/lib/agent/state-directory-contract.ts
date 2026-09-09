// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  AgentStateDirectory,
  AgentStateDirectoryPath,
} from "./definition-types";

type UnknownRecord = Record<string, unknown>;

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const STATE_DIRECTORY_FIELDS = new Set(["path", "prefix", "backup"]);
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

function readStateDirectory(entry: unknown, index: number): AgentStateDirectory {
  const field = `state_dirs[${String(index)}]`;
  if (typeof entry === "string") {
    assertCanonicalPath(entry, field);
    return { kind: "path", path: entry, backup: true };
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
  if (hasPath) {
    if (typeof path !== "string") {
      throw new Error(`Agent manifest field '${field}.path' must be a string`);
    }
    assertCanonicalPath(path, `${field}.path`);
    return { kind: "path", path, backup };
  }
  if (typeof prefix !== "string" || !SAFE_LOCK_NAME_RE.test(prefix)) {
    throw new Error(
      `Agent manifest field '${field}.prefix' must contain only letters, digits, '.', '_', or '-'`,
    );
  }
  return { kind: "prefix", prefix, backup };
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

function topLevelPath(value: string): string {
  const separator = value.indexOf("/");
  return separator === -1 ? value : value.slice(0, separator);
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
