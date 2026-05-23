// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export interface NpmLinkTargetPaths {
  binDir: string;
  libDir: string;
  nodeModulesDir: string;
  prefix: string;
}

export interface NpmLinkTargetState {
  exists: (targetPath: string) => boolean;
  isWritable: (targetPath: string) => boolean;
}

export type NpmLinkTargetWritableResult =
  | { ok: true; paths: NpmLinkTargetPaths }
  | { ok: false; paths: NpmLinkTargetPaths; reason: "empty-prefix" | "bin-unwritable" | "lib-unwritable" };

export function npmGlobalBin(prefix: string): string | null {
  const normalized = prefix.trim();
  return normalized ? path.join(normalized, "bin") : null;
}

export function npmLinkTargetPaths(prefix: string): NpmLinkTargetPaths {
  const normalized = prefix.trim();
  return {
    binDir: path.join(normalized, "bin"),
    libDir: path.join(normalized, "lib"),
    nodeModulesDir: path.join(normalized, "lib", "node_modules"),
    prefix: normalized,
  };
}

export function npmLinkTargetsWritable(
  prefix: string,
  state: NpmLinkTargetState,
): NpmLinkTargetWritableResult {
  const paths = npmLinkTargetPaths(prefix);
  if (!paths.prefix) return { ok: false, paths, reason: "empty-prefix" };

  if (state.exists(paths.binDir)) {
    if (!state.isWritable(paths.binDir)) return { ok: false, paths, reason: "bin-unwritable" };
  } else if (!state.isWritable(paths.prefix)) {
    return { ok: false, paths, reason: "bin-unwritable" };
  }

  if (state.exists(paths.nodeModulesDir)) {
    if (!state.isWritable(paths.nodeModulesDir)) return { ok: false, paths, reason: "lib-unwritable" };
  } else if (state.exists(paths.libDir)) {
    if (!state.isWritable(paths.libDir)) return { ok: false, paths, reason: "lib-unwritable" };
  } else if (!state.isWritable(paths.prefix)) {
    return { ok: false, paths, reason: "lib-unwritable" };
  }

  return { ok: true, paths };
}

export function pathWithPrependedEntries(currentPath: string, entries: readonly string[]): string {
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  const nextParts = [...parts];
  for (const entry of [...entries].reverse()) {
    if (entry && !nextParts.includes(entry)) nextParts.unshift(entry);
  }
  return nextParts.join(path.delimiter);
}
