#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs, { existsSync, lstatSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJsonObject,
  rejectUnsafePackageTree,
  requireRealDirectory,
} from "./bundled-npm-package.mts";
import {
  FIXED_UNDICI_INTEGRITY,
  FIXED_UNDICI_TARBALL,
  FIXED_UNDICI_VERSION,
  patchBundledNpmUndiciFromRegistry,
} from "./patch-bundled-npm-undici.mts";

import {
  patchOpenClaw105PluginDependencies,
  PLUGIN_SECURITY_REPLACEMENTS,
} from "./openclaw-npm-remediation.mts";

type LockEntry = Record<string, unknown>;

function rewriteRegularFile(
  filename: string,
  label: string,
  transform: (original: string) => string,
): void {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error(`${label} must be a real file`);
    const original = fs.readFileSync(descriptor, "utf8");
    const patched = transform(original);
    if (patched === original) return;
    const bytes = Buffer.from(patched);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!written) throw new Error(`${label} write made no progress`);
      offset += written;
    }
    fs.ftruncateSync(descriptor, bytes.length);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeUnchangedJsonObject(filename: string, expected: string, updated: object): void {
  rewriteRegularFile(filename, "OpenClaw remediation metadata", (original) => {
    if (JSON.stringify(JSON.parse(original)) !== expected)
      throw new Error("OpenClaw remediation metadata changed before writing");
    return `${JSON.stringify(updated, null, 2)}\n`;
  });
}

/** OpenClaw copies these overrides into each official plugin's managed npm project. */
export function patchOpenClawManagedPluginOverrides(packageDirectory: string): void {
  requireRealDirectory(packageDirectory, "OpenClaw managed override owner");
  const manifest = readJsonObject(
    join(packageDirectory, "package.json"),
    "OpenClaw override owner",
  );
  if (manifest.name !== "openclaw" || manifest.version !== "2026.10.5") {
    throw new Error("OpenClaw managed override owner identity has drifted");
  }
  const filename = join(packageDirectory, "pnpm-workspace.yaml");
  rewriteRegularFile(filename, "OpenClaw managed overrides", (original) => {
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    if (digest(original) === "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb")
      return original;
    if (digest(original) !== "c95a6b7be1fa13956265abbff9bc9895064bf6677123c88314ef4dc20410bda3")
      throw new Error("OpenClaw managed override source integrity mismatch");
    const patched = original
      .replace(
        "overrides:\n",
        "overrides:\n" +
          '  "@azure/msal-node": 7.1.0\n  body-parser: 2.4.0\n  undici: 8.12.3\n  zod: 4.6.6\n',
      )
      .replace("  qs: 6.16.0\n", "  qs: 6.16.1\n");
    if (digest(patched) !== "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb")
      throw new Error("OpenClaw managed override replacement integrity mismatch");
    return patched;
  });
}

function remediatePluginDependencies(
  root: string,
  packages: Record<string, LockEntry>,
  updateLock: boolean,
): void {
  for (const name of ["discord", "googlechat", "slack"]) {
    const location = `node_modules/@openclaw/${name}`;
    if (packages[location]?.version !== "2026.10.5") continue;
    const dependencies: Record<string, keyof typeof PLUGIN_SECURITY_REPLACEMENTS> = {
      [`${location}/node_modules/zod`]: "zod",
    };
    if (name !== "googlechat") dependencies[`${location}/node_modules/undici`] = "undici";
    if (name === "discord")
      dependencies[`${location}/node_modules/@discord/embedded-app-sdk/node_modules/zod`] = "zod";
    if (name === "slack") {
      const body = `${location}/node_modules/@slack/bolt/node_modules/body-parser`;
      dependencies[body] = "body-parser";
      dependencies[`${body}/node_modules/content-type`] = "content-type";
      dependencies[`${body}/node_modules/qs`] = "qs";
    }
    if (!updateLock) {
      for (const [dependency, key] of Object.entries(dependencies)) {
        const identity = PLUGIN_SECURITY_REPLACEMENTS[key];
        if (
          packages[dependency]?.version !== identity.version ||
          packages[dependency]?.integrity !== identity.integrity
        ) {
          throw new Error(`Plugin security remediation lock identity has drifted: ${dependency}`);
        }
      }
    }
    patchOpenClaw105PluginDependencies(join(root, location), root);
    if (updateLock) {
      packages[location].dependencies = readJsonObject(
        join(root, location, "package.json"),
        "Remediated plugin",
      ).dependencies;
      for (const [dependency, key] of Object.entries(dependencies)) {
        const identity = PLUGIN_SECURITY_REPLACEMENTS[key];
        const installed = readJsonObject(
          join(root, dependency, "package.json"),
          "Remediated plugin dependency",
        );
        const entry: LockEntry = {
          version: identity.version,
          resolved: identity.tarball,
          integrity: identity.integrity,
          license: installed.license,
        };
        for (const field of [
          "dependencies",
          "optionalDependencies",
          "peerDependencies",
          "peerDependenciesMeta",
          "engines",
          "bin",
        ]) {
          if (installed[field] !== undefined) entry[field] = installed[field];
        }
        packages[dependency] = entry;
      }
      if (name === "discord") {
        const sdk = packages[`${location}/node_modules/@discord/embedded-app-sdk`];
        sdk.dependencies = readJsonObject(
          join(root, location, "node_modules/@discord/embedded-app-sdk/package.json"),
          "Discord SDK",
        ).dependencies;
      }
    }
  }
}

function verifyMigrationHttpClient(root: string): void {
  const requireFromConsumer = createRequire(join(root, "node_modules", "openclaw", "package.json"));
  const resolved = requireFromConsumer.resolve("undici/package.json");
  if (resolved !== join(root, "node_modules", "undici", "package.json")) {
    throw new Error("OpenClaw migration did not resolve the reviewed HTTP client");
  }
  const installed = readJsonObject(resolved, "OpenClaw migration HTTP client");
  if (installed.name !== "undici" || installed.version !== "8.12.3") {
    throw new Error("OpenClaw migration HTTP client identity mismatch");
  }
}

/** Apply the reviewed runtime recipe before checking the final installed lock. */
export function remediateOpenClawRuntimeDependencies(
  directory: string,
  options: Readonly<{ updateLock?: boolean }> = {},
): void {
  const root = requireRealDirectory(directory, "OpenClaw runtime root");
  requireRealDirectory(join(root, "node_modules"), "OpenClaw runtime node_modules");
  const lockfile = join(root, "package-lock.json");
  const lock = readJsonObject(lockfile, "OpenClaw runtime lock");
  const originalLock = JSON.stringify(lock);
  if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error("OpenClaw runtime lock has no packages map");
  }
  const packages = lock.packages as Record<string, LockEntry>;
  const npm = packages["node_modules/npm"];
  const npmUndiciLocation = "node_modules/npm/node_modules/undici";
  const npmUndici = packages[npmUndiciLocation];
  if (npm !== undefined) {
    if (
      npm.version !== "12.2.1" ||
      !npmUndici ||
      (npmUndici.version !== FIXED_UNDICI_VERSION &&
        !(options.updateLock && npmUndici.version === "6.29.0"))
    ) {
      throw new Error("OpenClaw runtime npm remediation lock identity has drifted");
    }
    patchBundledNpmUndiciFromRegistry(join(root, "node_modules", "npm"));
    if (options.updateLock) {
      npmUndici.version = FIXED_UNDICI_VERSION;
      npmUndici.resolved = FIXED_UNDICI_TARBALL;
      npmUndici.integrity = FIXED_UNDICI_INTEGRITY;
      delete npmUndici.inBundle;
    }
  }

  const legacyUndiciLocation = "node_modules/openclaw/node_modules/undici";
  if (packages["node_modules/openclaw"]?.version === "2026.9.7") {
    const replacement = packages["node_modules/undici"];
    if (replacement?.version !== "8.12.3") {
      throw new Error("OpenClaw migration runtime requires reviewed undici@8.12.3");
    }
    const legacy = packages[legacyUndiciLocation];
    if (legacy !== undefined && !(options.updateLock && legacy.version === "8.10.2")) {
      throw new Error("OpenClaw migration runtime retains an unremediated bundled HTTP client");
    }
    const destination = join(root, legacyUndiciLocation);
    requireRealDirectory(join(root, "node_modules", "openclaw"), "OpenClaw migration package");
    requireRealDirectory(join(root, "node_modules", "undici"), "OpenClaw replacement HTTP client");
    const consumer = join(root, "node_modules", "openclaw", "package.json");
    const owner = readJsonObject(consumer, "OpenClaw migration package");
    if (owner.name !== "openclaw" || owner.version !== "2026.9.7") {
      throw new Error("OpenClaw migration package identity has drifted");
    }
    if (existsSync(destination) || lstatSync(destination, { throwIfNoEntry: false })) {
      requireRealDirectory(destination, "OpenClaw bundled undici");
      const bundled = readJsonObject(join(destination, "package.json"), "OpenClaw bundled undici");
      if (bundled.name !== "undici" || bundled.version !== "8.10.2") {
        throw new Error("OpenClaw migration bundled undici identity has drifted");
      }
      rejectUnsafePackageTree(destination, "OpenClaw migration bundled HTTP client");
      const backup = join(dirname(destination), ".undici-security-remediation-backup");
      if (lstatSync(backup, { throwIfNoEntry: false })) {
        throw new Error("OpenClaw migration undici recovery directory already exists");
      }
      renameSync(destination, backup);
      try {
        verifyMigrationHttpClient(root);
      } catch (error) {
        try {
          renameSync(backup, destination);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `OpenClaw HTTP client recovery retained at ${backup}`,
          );
        }
        throw error;
      }
      rmSync(backup, { recursive: true });
    } else {
      verifyMigrationHttpClient(root);
    }
    if (options.updateLock) delete packages[legacyUndiciLocation];
  }
  if (packages["node_modules/openclaw"]?.version === "2026.10.5") {
    patchOpenClawManagedPluginOverrides(join(root, "node_modules/openclaw"));
    const ownerFile = join(root, "node_modules/openclaw/package.json");
    const owner = readJsonObject(ownerFile, "OpenClaw runtime owner");
    const originalOwner = JSON.stringify(owner);
    const dependencies = owner.dependencies as Record<string, unknown>;
    if (dependencies?.undici !== "8.11.2" && dependencies?.undici !== "8.12.3")
      throw new Error("OpenClaw HTTP dependency declaration has drifted");
    dependencies.undici = "8.12.3";
    if (dependencies.npm !== "12.2.0" && dependencies.npm !== "12.2.1")
      throw new Error("OpenClaw npm dependency declaration has drifted");
    dependencies.npm = "12.2.1";
    writeUnchangedJsonObject(ownerFile, originalOwner, owner);
    if (options.updateLock) packages["node_modules/openclaw"].dependencies = dependencies;
  }
  remediatePluginDependencies(root, packages, options.updateLock === true);
  if (options.updateLock) writeUnchangedJsonObject(lockfile, originalLock, lock);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--prefix" || !args[1]) {
    throw new Error("Expected --prefix <installed OpenClaw runtime directory>");
  }
  remediateOpenClawRuntimeDependencies(args[1]);
}
