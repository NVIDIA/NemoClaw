#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This script is also bind-mounted into completed images as a standalone file.
// The test suite binds this floor to the patcher's canonical remediation floor.
export const MINIMUM_SAFE_NODE_TAR_VERSION = "7.5.19";

type ExactVersion = readonly [number, number, number];

export type NodeTarImagePackage = Readonly<{
  aliases: readonly string[];
  device: string;
  inode: string;
  physicalPath: string;
  status: "affected" | "fixed" | "invalid";
  version: string;
}>;

export type NodeTarImageScan = Readonly<{
  image: string;
  minimumVersion: string;
  packageCount: number;
  packages: readonly NodeTarImagePackage[];
  schema: 1;
}>;

function parseExactVersion(version: string): ExactVersion | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function atLeast(version: ExactVersion, minimum: ExactVersion): boolean {
  for (let index = 0; index < version.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index]! > minimum[index]!;
  }
  return true;
}

function findPackageManifests(root: string): string[] {
  const result = spawnSync(
    "find",
    ["-L", root, "-xdev", "-type", "f", "-path", "*/node_modules/tar/package.json", "-print0"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`node-tar filesystem search failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

function readPackageManifest(manifestPath: string): {
  device: string;
  inode: string;
  physicalPath: string;
  value: unknown;
} {
  const descriptor = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`node-tar manifest is not a file: ${manifestPath}`);
    const physicalManifestPath = realpathSync(manifestPath);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch {
      value = undefined;
    }
    return {
      device: String(metadata.dev),
      inode: String(metadata.ino),
      physicalPath: dirname(physicalManifestPath),
      value,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function scanNodeTarImage(root: string, image: string): NodeTarImageScan {
  const scanRoot = resolve(root);
  const grouped = new Map<
    string,
    { aliases: Set<string>; device: string; inode: string; physicalPath: string; version: string }
  >();
  for (const manifestPath of findPackageManifests(scanRoot)) {
    const { device, inode, physicalPath, value: manifest } = readPackageManifest(manifestPath);
    const key = physicalPath;
    const version =
      typeof manifest === "object" &&
      manifest !== null &&
      !Array.isArray(manifest) &&
      (manifest as Record<string, unknown>).name === "tar" &&
      typeof (manifest as Record<string, unknown>).version === "string"
        ? String((manifest as Record<string, unknown>).version)
        : "";
    const existing = grouped.get(key);
    if (existing && existing.version !== version) {
      throw new Error(`node-tar manifest changed while scanning: ${manifestPath}`);
    }
    const entry = existing ?? {
      aliases: new Set<string>(),
      device,
      inode,
      physicalPath,
      version,
    };
    entry.aliases.add(dirname(manifestPath));
    grouped.set(key, entry);
  }

  const minimum = parseExactVersion(MINIMUM_SAFE_NODE_TAR_VERSION)!;
  const packages = [...grouped.values()]
    .map((entry): NodeTarImagePackage => {
      const version = parseExactVersion(entry.version);
      return {
        aliases: [...entry.aliases].sort(),
        device: entry.device,
        inode: entry.inode,
        physicalPath: entry.physicalPath,
        status: version ? (atLeast(version, minimum) ? "fixed" : "affected") : "invalid",
        version: entry.version,
      };
    })
    .sort((first, second) => first.physicalPath.localeCompare(second.physicalPath));

  return {
    image,
    minimumVersion: MINIMUM_SAFE_NODE_TAR_VERSION,
    packageCount: packages.length,
    packages,
    schema: 1,
  };
}

export function nodeTarImageScanErrors(scan: NodeTarImageScan): string[] {
  const errors: string[] = [];
  if (scan.packageCount === 0)
    errors.push("completed image contains no discoverable node-tar copy");
  for (const entry of scan.packages) {
    if (entry.status !== "fixed") {
      errors.push(
        `${entry.physicalPath} contains ${entry.version ? `tar@${entry.version}` : "invalid tar metadata"}`,
      );
    }
  }
  return errors;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function isMainModule(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

if (isMainModule()) {
  try {
    const scan = scanNodeTarImage(argument("--root"), argument("--image"));
    process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
    const errors = nodeTarImageScanErrors(scan);
    if (errors.length > 0) {
      for (const error of errors) console.error(`ERROR: ${error}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
