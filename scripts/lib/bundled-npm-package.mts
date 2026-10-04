// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export type JsonObject = Record<string, unknown>;

export function jsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

export function readJsonObject(file: string, label: string): JsonObject {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a real file: ${file}`);
    return jsonObject(JSON.parse(readFileSync(descriptor, "utf8")), label);
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error)}`);
  } finally {
    closeSync(descriptor);
  }
}

export function requireRealDirectory(directory: string, label: string): string {
  const resolved = resolve(directory);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${resolved}`);
  }
  return realpathSync(resolved);
}

export function rejectUnsafePackageTree(root: string, label: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`${label} contains an unsafe member: ${entry.name}`);
    }
    if (entry.isDirectory()) rejectUnsafePackageTree(join(root, entry.name), label);
  }
}

function isContainedBinSymlink(
  nodeModulesRoot: string,
  directory: string,
  entryName: string,
): boolean {
  if (basename(directory) !== ".bin") return false;
  try {
    const target = realpathSync(join(directory, entryName));
    const targetRelative = relative(nodeModulesRoot, target);
    return (
      targetRelative !== "" &&
      targetRelative !== ".." &&
      !targetRelative.startsWith(`..${sep}`) &&
      !isAbsolute(targetRelative) &&
      lstatSync(target).isFile()
    );
  } catch {
    return false;
  }
}

export function collectBundledPackageVersions(options: {
  ignoredDirectoryPrefixes: readonly string[];
  nodeModulesRoot: string;
  packageName: string;
}): string[] {
  const versions: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        if (!isContainedBinSymlink(options.nodeModulesRoot, directory, entry.name)) {
          throw new Error(`npm package contains an unsafe symlink: ${join(directory, entry.name)}`);
        }
        continue;
      }
      if (
        entry.isDirectory() &&
        options.ignoredDirectoryPrefixes.some((prefix) => entry.name.startsWith(prefix))
      ) {
        continue;
      }
      const child = join(directory, entry.name);
      if (!entry.isDirectory() && !entry.isFile()) {
        throw new Error(`npm package contains an unsafe member: ${child}`);
      }
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      if (entry.name !== "package.json") continue;
      const manifest = readJsonObject(child, "npm bundled package manifest");
      if (manifest.name !== options.packageName) continue;
      if (typeof manifest.version !== "string") {
        throw new Error(`npm bundled ${options.packageName} version is invalid`);
      }
      versions.push(manifest.version);
    }
  };
  visit(options.nodeModulesRoot);
  return versions;
}
