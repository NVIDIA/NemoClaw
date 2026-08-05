// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { SandboxHostMount } from "./types";

const SANDBOX_MOUNT_PREFIX = "/sandbox/";

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
  const separator = value.lastIndexOf(":/sandbox/");
  if (separator <= 0) {
    failHostMount(value, "expected HOST_DIRECTORY:/sandbox/DIRECTORY");
  }
  const requestedSource = value.slice(0, separator);
  const requestedTarget = value.slice(separator + 1);
  if (/\p{Cc}/u.test(requestedSource) || /\p{Cc}/u.test(requestedTarget)) {
    failHostMount(value, "paths must not contain control characters");
  }
  if (!path.isAbsolute(requestedSource)) {
    failHostMount(value, "host directory must be an absolute path");
  }
  const source = path.resolve(requestedSource);
  assertNoSymlinkComponents(source, value);
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.statSync(source);
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
  return { source, target, readOnly: true };
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

export function cloneSandboxHostMounts(
  mounts: readonly SandboxHostMount[] | undefined,
): SandboxHostMount[] {
  return (mounts ?? []).map(({ source, target }) => ({ source, target, readOnly: true }));
}
