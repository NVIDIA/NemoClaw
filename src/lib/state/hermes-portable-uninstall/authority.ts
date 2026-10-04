// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { writeConfigFile } from "../config-io";
import { readGatewayRegistryFile, type GatewayRegistryDocument } from "../gateway-registry";
import { isPortableUninstallMissingPathError } from "../portable-uninstall-retirement";
import type { HermesPortableUninstallAuthority } from "./journal";

const MAX_AUTHORITY_DIRECTORY_ENTRIES = 64;
const MAX_AUTHORITY_FILE_BYTES = 1024 * 1024;

export interface HermesPortableUninstallRegistryInput {
  readonly homeDir: string;
  readonly registryFile: string;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hermesPortableUninstallTextSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hermesPortableUninstallDigest(value: unknown): string {
  return hermesPortableUninstallTextSha256(stableJson(value));
}

export function hermesPortableUninstallPathDigest(value: string): string {
  return hermesPortableUninstallDigest(path.resolve(value));
}

export function hermesPortableUninstallSandboxStem(sandboxName: string): string {
  return hermesPortableUninstallTextSha256(sandboxName);
}

export function hermesPortableInferenceStateDirectory(
  sandboxName: string,
  stateDir: string,
): string {
  return path.join(stateDir, "portable-inference", hermesPortableUninstallDigest({ sandboxName }));
}

function statAuthority(stat: fs.BigIntStats): object {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

export function inspectHermesPortableUninstallDirectoryAuthority(directory: string): string | null {
  let root: fs.BigIntStats;
  try {
    root = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    if (isPortableUninstallMissingPathError(error)) return null;
    throw error;
  }
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== BigInt(uid) ||
    (root.mode & 0o777n) !== 0o700n
  ) {
    throw new Error(`Hermes Portable uninstall authority directory is unsafe: ${directory}`);
  }
  let count = 0;
  const entries: object[] = [{ path: ".", kind: "directory", stat: statAuthority(root) }];
  const walk = (current: string, relative: string): void => {
    const names = fs.readdirSync(current).sort();
    count += names.length;
    if (count > MAX_AUTHORITY_DIRECTORY_ENTRIES) {
      throw new Error(`Hermes Portable uninstall authority directory is too large: ${directory}`);
    }
    for (const name of names) {
      const child = path.join(current, name);
      const childRelative = relative ? path.join(relative, name) : name;
      const descriptor = fs.openSync(
        child,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0),
      );
      try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        const named = fs.lstatSync(child, { bigint: true });
        if (
          named.isSymbolicLink() ||
          !isDeepStrictEqual(statAuthority(opened), statAuthority(named)) ||
          opened.uid !== BigInt(uid)
        ) {
          throw new Error(`Hermes Portable uninstall authority entry is unsafe: ${child}`);
        }
        if (opened.isDirectory()) {
          if ((opened.mode & 0o777n) !== 0o700n) {
            throw new Error(
              `Hermes Portable uninstall authority directory is not private: ${child}`,
            );
          }
          entries.push({ path: childRelative, kind: "directory", stat: statAuthority(opened) });
          walk(child, childRelative);
          if (
            !isDeepStrictEqual(
              statAuthority(opened),
              statAuthority(fs.fstatSync(descriptor, { bigint: true })),
            ) ||
            !isDeepStrictEqual(
              statAuthority(opened),
              statAuthority(fs.lstatSync(child, { bigint: true })),
            )
          ) {
            throw new Error(`Hermes Portable uninstall authority directory changed: ${child}`);
          }
          continue;
        }
        if (
          !opened.isFile() ||
          opened.nlink !== 1n ||
          (opened.mode & 0o777n) !== 0o600n ||
          opened.size > BigInt(MAX_AUTHORITY_FILE_BYTES)
        ) {
          throw new Error(`Hermes Portable uninstall authority file is unsafe: ${child}`);
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, { bigint: true });
        if (
          !isDeepStrictEqual(statAuthority(opened), statAuthority(after)) ||
          !isDeepStrictEqual(
            statAuthority(opened),
            statAuthority(fs.lstatSync(child, { bigint: true })),
          )
        ) {
          throw new Error(`Hermes Portable uninstall authority file changed: ${child}`);
        }
        entries.push({
          path: childRelative,
          kind: "file",
          stat: statAuthority(after),
          sha256: hermesPortableUninstallTextSha256(bytes),
        });
      } finally {
        fs.closeSync(descriptor);
      }
    }
  };
  walk(directory, "");
  if (
    !isDeepStrictEqual(
      statAuthority(root),
      statAuthority(fs.lstatSync(directory, { bigint: true })),
    )
  ) {
    throw new Error(`Hermes Portable uninstall authority directory changed: ${directory}`);
  }
  return hermesPortableUninstallDigest(entries);
}

export function readHermesPortableUninstallRegistry(
  input: HermesPortableUninstallRegistryInput,
): GatewayRegistryDocument {
  const registry = readGatewayRegistryFile(input.homeDir, input.registryFile);
  if (!registry) throw new Error("Hermes Portable uninstall registry authority is missing");
  return registry;
}

export function retireHermesPortableUninstallDirectory(
  directory: string,
  expectedSha256: string,
): void {
  const current = inspectHermesPortableUninstallDirectoryAuthority(directory);
  if (current === null) return;
  if (current !== expectedSha256) {
    throw new Error(`Hermes Portable uninstall evidence changed before retirement: ${directory}`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
  if (inspectHermesPortableUninstallDirectoryAuthority(directory) !== null) {
    throw new Error(`Hermes Portable uninstall evidence remained after retirement: ${directory}`);
  }
}

export function retireHermesPortableUninstallRegistryRows(
  input: HermesPortableUninstallRegistryInput,
  authority: HermesPortableUninstallAuthority,
): void {
  const current = readHermesPortableUninstallRegistry(input);
  const nextSandboxes = { ...current.sandboxes };
  for (const target of authority.targets) {
    const row = nextSandboxes[target.sandboxName];
    if (!row) continue;
    if (hermesPortableUninstallDigest(row) !== target.registryRowSha256) {
      throw new Error(
        `Hermes Portable uninstall registry row '${target.sandboxName}' was replaced`,
      );
    }
    delete nextSandboxes[target.sandboxName];
  }
  const next: GatewayRegistryDocument = {
    ...current,
    defaultSandbox:
      current.defaultSandbox &&
      authority.targets.some(({ sandboxName }) => sandboxName === current.defaultSandbox)
        ? null
        : current.defaultSandbox,
    sandboxes: nextSandboxes,
  };
  if (!isDeepStrictEqual(next, current)) writeConfigFile(input.registryFile, next);
  const verified = readHermesPortableUninstallRegistry(input);
  if (!isDeepStrictEqual(verified, next)) {
    throw new Error("Hermes Portable uninstall registry retirement could not be verified");
  }
}

export function verifyHermesPortableUninstallRegistryRetired(
  input: HermesPortableUninstallRegistryInput,
  authority: HermesPortableUninstallAuthority,
): void {
  const registry = readHermesPortableUninstallRegistry(input);
  for (const target of authority.targets) {
    const row = registry.sandboxes[target.sandboxName];
    if (row && hermesPortableUninstallDigest(row) !== target.registryRowSha256) {
      throw new Error(
        `Hermes Portable uninstall found same-name registry replacement '${target.sandboxName}'`,
      );
    }
    if (row) {
      throw new Error(`Hermes Portable uninstall registry row '${target.sandboxName}' remains`);
    }
  }
}
