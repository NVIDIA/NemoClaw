// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { SandboxHostMount } from "./types";

const SANDBOX_MOUNT_PREFIX = "/sandbox/";
const UNSAFE_TERMINAL_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function hasUnsafeHostMountTerminalText(value: string): boolean {
  return UNSAFE_TERMINAL_TEXT.test(value);
}

function failHostMount(value: string, detail: string): never {
  throw new Error(`Invalid --host-mount '${value}': ${detail}`);
}

function assertNoSymlinkComponents(source: string, original: string): void {
  const parsed = path.parse(source);
  let current = parsed.root;
  for (const segment of source.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      failHostMount(original, `host directory does not exist: ${source}`);
    }
    if (stat.isSymbolicLink()) {
      failHostMount(original, `host path must not contain symlinks: ${current}`);
    }
  }
}

export function parseReadOnlyHostMount(value: string): SandboxHostMount {
  if (hasUnsafeHostMountTerminalText(value)) {
    throw new Error("Invalid --host-mount: paths must not contain terminal control characters");
  }
  const separator = value.lastIndexOf(":/sandbox/");
  if (separator <= 0) {
    failHostMount(value, "expected HOST_DIRECTORY:/sandbox/DIRECTORY");
  }
  const requestedSource = value.slice(0, separator);
  const requestedTarget = value.slice(separator + 1);
  if (!path.isAbsolute(requestedSource)) {
    failHostMount(value, "host directory must be an absolute path");
  }
  const source = path.resolve(requestedSource);
  assertNoSymlinkComponents(source, value);
  let sourceStat: fs.BigIntStats;
  try {
    sourceStat = fs.statSync(source, { bigint: true });
  } catch {
    failHostMount(value, `host directory does not exist: ${source}`);
  }
  if (!sourceStat.isDirectory()) {
    failHostMount(value, `host path must be a directory: ${source}`);
  }

  const target = path.posix.normalize(requestedTarget);
  if (target !== requestedTarget || !target.startsWith(SANDBOX_MOUNT_PREFIX)) {
    failHostMount(value, "sandbox directory must be a normalized absolute path below /sandbox");
  }
  return {
    source,
    target,
    readOnly: true,
    sourceIdentity: { device: sourceStat.dev.toString(), inode: sourceStat.ino.toString() },
  };
}

export function parseReadOnlyHostMounts(values: readonly string[]): SandboxHostMount[] {
  const mounts = values.map(parseReadOnlyHostMount);
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const mount of mounts) {
    if (sources.has(mount.source)) {
      throw new Error(`Duplicate --host-mount host directory: ${mount.source}`);
    }
    if (targets.has(mount.target)) {
      throw new Error(`Duplicate --host-mount sandbox directory: ${mount.target}`);
    }
    sources.add(mount.source);
    targets.add(mount.target);
  }
  return mounts;
}

/** Validate user-editable durable state again before it can drive a sandbox. */
export function normalizePersistedSandboxHostMounts(value: unknown): SandboxHostMount[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Persisted host mount state must be an array; repair the local state first.");
  }
  const declarations = value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof (candidate as Record<string, unknown>).source !== "string" ||
      typeof (candidate as Record<string, unknown>).target !== "string" ||
      (candidate as Record<string, unknown>).readOnly !== true
    ) {
      throw new Error(
        "Persisted state contains an invalid read-only host mount; repair the local state first.",
      );
    }
    const mount = candidate as unknown as SandboxHostMount;
    return `${mount.source}:${mount.target}`;
  });
  try {
    return parseReadOnlyHostMounts(declarations);
  } catch (error) {
    throw new Error(
      `Persisted state contains an invalid read-only host mount; repair the local state first. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function canonicalHostMounts(mounts: readonly SandboxHostMount[]): string {
  return JSON.stringify(
    mounts
      .map(({ source, target }) => ({ source, target, readOnly: true as const }))
      .sort((left, right) => {
        const leftKey = `${left.source}\0${left.target}`;
        const rightKey = `${right.source}\0${right.target}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  );
}

/** Revalidate both declarations before deciding whether a live sandbox can be reused. */
export function persistedSandboxHostMountsEqual(left: unknown, right: unknown): boolean {
  return (
    canonicalHostMounts(normalizePersistedSandboxHostMounts(left)) ===
    canonicalHostMounts(normalizePersistedSandboxHostMounts(right))
  );
}

/** Revalidate path safety and the captured inode immediately before sandbox creation. */
export function verifyReadOnlyHostMountSources(
  mounts: readonly SandboxHostMount[] | undefined,
): void {
  for (const mount of mounts ?? []) {
    const expected = mount.sourceIdentity;
    if (!expected) {
      throw new Error(
        `Read-only host mount source identity is missing for ${mount.source}; validate the mount again.`,
      );
    }
    let current: SandboxHostMount;
    try {
      [current] = normalizePersistedSandboxHostMounts([mount]);
    } catch (error) {
      throw new Error(`Read-only host mount source changed after validation: ${mount.source}`, {
        cause: error,
      });
    }
    if (
      current.sourceIdentity?.device !== expected.device ||
      current.sourceIdentity.inode !== expected.inode
    ) {
      throw new Error(`Read-only host mount source changed after validation: ${mount.source}`);
    }
  }
}

export function cloneSandboxHostMounts(
  mounts: readonly SandboxHostMount[] | undefined,
): SandboxHostMount[] {
  return (mounts ?? []).map(({ source, target, sourceIdentity }) => ({
    source,
    target,
    readOnly: true,
    ...(sourceIdentity ? { sourceIdentity: { ...sourceIdentity } } : {}),
  }));
}
