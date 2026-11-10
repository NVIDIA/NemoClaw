// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJsonRecord(filename: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`managed messaging install metadata is not an object: ${filename}`);
  }
  return value as Record<string, unknown>;
}

function overridePackageName(selector: string): string {
  const versionSeparator = selector.lastIndexOf("@");
  const packageName = versionSeparator > 0 ? selector.slice(0, versionSeparator) : selector;
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageName)) {
    throw new Error(`managed messaging override selector is invalid: ${selector}`);
  }
  return packageName;
}

export function managedMessagingNestedOverridePaths(
  manifest: Record<string, unknown>,
  packages: Record<string, unknown>,
): readonly string[] {
  const overrides = manifest.overrides;
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    throw new Error("managed messaging manifest is missing its overrides map");
  }
  const locations = new Set<string>();
  const metadata = (location: string): Record<string, unknown> => {
    const value = packages[location];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`managed messaging lockfile is missing nested override: ${location}`);
    }
    return value as Record<string, unknown>;
  };
  const candidates = (selector: string, parent: string): string[] => {
    const name = overridePackageName(selector);
    const suffix = `node_modules/${name}`;
    const version = selector.slice(name.length).replace(/^@/u, "");
    const matches = (location: string): boolean =>
      (location === suffix || location.endsWith(`/${suffix}`)) &&
      (!version || metadata(location).version === version);
    // npm overrides apply to descendants, including dependencies nested below
    // another bundled dependency (for example Baileys -> music-metadata).
    const nested = Object.keys(packages).filter(
      (location) =>
        (!parent || location.startsWith(`${parent}/node_modules/`)) && matches(location),
    );
    if (nested.length > 0) return nested;
    // npm may hoist the replacement into an ancestor's node_modules. Resolve
    // the nearest package first; a mismatching version must not fall through.
    let directory = parent;
    while (directory) {
      const location = `${directory}/${suffix}`;
      if (packages[location] !== undefined) return matches(location) ? [location] : [];
      const index = directory.lastIndexOf("/node_modules/");
      directory = index < 0 ? "" : directory.slice(0, index);
    }
    return packages[suffix] !== undefined && matches(suffix) ? [suffix] : [];
  };
  const visit = (node: Record<string, unknown>, parent: string, depth: number): void => {
    for (const [selector, value] of Object.entries(node)) {
      if (selector === ".") continue;
      if (typeof value === "string") {
        if (depth > 0) {
          const targets = candidates(selector, parent);
          if (targets.length === 0) {
            throw new Error(
              `managed messaging lockfile is missing nested override: ${parent}/${selector}`,
            );
          }
          const alias = /^npm:(.+)@([^@]+)$/u.exec(value);
          const expectedVersion = alias?.[2] ?? value;
          for (const location of targets) {
            const entry = metadata(location);
            if (entry.version !== expectedVersion || (alias && entry.name !== alias[1])) {
              throw new Error(`managed messaging locked override mismatch: ${location}`);
            }
            locations.add(location);
          }
        }
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`managed messaging override value is invalid: ${selector}`);
      }
      const targets = candidates(selector, parent);
      if (targets.length === 0) {
        throw new Error(`managed messaging lockfile is missing override scope: ${selector}`);
      }
      for (const location of targets) visit(value as Record<string, unknown>, location, depth + 1);
    }
  };
  visit(overrides as Record<string, unknown>, "", 0);
  return Object.freeze([...locations].sort());
}

export function verifyManagedMessagingOfflineInstall(lockfile: string, prefix: string): void {
  const lock = readJsonRecord(lockfile);
  const manifest = readJsonRecord(path.join(path.dirname(lockfile), "package.json"));
  const packages = lock.packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    throw new Error("managed messaging lockfile is missing its packages map");
  }

  for (const location of managedMessagingNestedOverridePaths(
    manifest,
    packages as Record<string, unknown>,
  )) {
    const locked = (packages as Record<string, unknown>)[location];
    if (typeof locked !== "object" || locked === null || Array.isArray(locked)) {
      throw new Error(`managed messaging lockfile is missing nested override: ${location}`);
    }
    const expectedVersion = (locked as Record<string, unknown>).version;
    if (typeof expectedVersion !== "string" || !expectedVersion) {
      throw new Error(`managed messaging lockfile has no version for nested override: ${location}`);
    }
    const installed = readJsonRecord(path.join(prefix, location, "package.json"));
    const expectedName = (locked as Record<string, unknown>).name;
    if (
      installed.version !== expectedVersion ||
      (typeof expectedName === "string" && installed.name !== expectedName)
    ) {
      throw new Error(
        `managed messaging nested override mismatch: ${location}: expected ${expectedVersion}, got ${String(installed.version)}`,
      );
    }
  }
}

function cliArguments(args: readonly string[]): {
  lockfile: string;
  prefix: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if ((name !== "--lockfile" && name !== "--prefix") || !value) {
      throw new Error(
        "usage: verify-managed-messaging-offline-install.mts --lockfile <file> --prefix <directory>",
      );
    }
    values.set(name, value);
  }
  const lockfile = values.get("--lockfile");
  const prefix = values.get("--prefix");
  if (!lockfile || !prefix || values.size !== 2) {
    throw new Error(
      "usage: verify-managed-messaging-offline-install.mts --lockfile <file> --prefix <directory>",
    );
  }
  return { lockfile, prefix };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { lockfile, prefix } = cliArguments(process.argv.slice(2));
  verifyManagedMessagingOfflineInstall(lockfile, prefix);
}
