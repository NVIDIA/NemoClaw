#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type JsonObject,
  type BundledNpmCommandRunner,
  type PreparedBundledReplacement,
  replaceBundledPackage,
  reconcileBundledPackageBackup,
  restoreMissingBundledPackage,
  prepareBundledPackageReplacement,
  remediateBundledPackageFromRegistry,
  runBundledNpmCommand,
  collectBundledPackageVersions,
  jsonObject as record,
  readJsonObject as readJson,
  rejectUnsafePackageTree,
  requireRealDirectory as realDirectory,
} from "./bundled-npm-package.mts";
import { REVIEWED_NPM_VERSION } from "./reviewed-npm-identity.mts";

export { REVIEWED_NPM_VERSION };

export const AFFECTED_UNDICI_VERSION = "6.27.0";
export const FIXED_UNDICI_VERSION = "6.29.1";
export const FIXED_UNDICI_INTEGRITY =
  "sha512-EvRlUt/QqAEvXdQeRMYUfwOQsfzpDztykrG2owGEE/rBOBoYv9uF39ZzsNDh4lTFHhTr2XOZjKkYgueD12ZmGA==";
export const FIXED_UNDICI_TARBALL = "https://registry.npmjs.org/undici/-/undici-6.29.1.tgz";

const REVIEWED_UNDICI_VERSIONS = new Set([AFFECTED_UNDICI_VERSION, "6.29.0", FIXED_UNDICI_VERSION]);

function verifyUndiciManifest(manifest: JsonObject): string {
  const version = manifest.version;
  const engines = record(manifest.engines, "npm bundled undici engines");
  if (
    manifest.name !== "undici" ||
    typeof version !== "string" ||
    !REVIEWED_UNDICI_VERSIONS.has(version) ||
    manifest.main !== "index.js" ||
    manifest.types !== "index.d.ts" ||
    manifest.license !== "MIT" ||
    engines.node !== ">=18.17" ||
    manifest.dependencies !== undefined
  ) {
    throw new Error(
      `npm bundled undici identity or package contract has drifted: ${JSON.stringify({
        dependencies: manifest.dependencies,
        engines,
        license: manifest.license,
        main: manifest.main,
        types: manifest.types,
        version,
      })}`,
    );
  }
  return version;
}

export type BundledNpmUndiciState = Readonly<{
  undiciVersion: string;
  npmVersion: string;
  state: "affected" | "fixed";
}>;

function inspectNpmVersion(root: string): string {
  const npmManifest = readJson(join(root, "package.json"), "npm package manifest");
  const npmVersion = npmManifest.version;
  if (
    npmManifest.name !== "npm" ||
    (npmVersion !== REVIEWED_NPM_VERSION && npmVersion !== "12.2.1")
  ) {
    throw new Error(
      `npm package identity has drifted; expected npm@${REVIEWED_NPM_VERSION} or npm@12.2.1`,
    );
  }

  return npmVersion;
}

export function inspectBundledNpmUndici(npmRoot: string): BundledNpmUndiciState {
  const root = realDirectory(npmRoot, "npm package root");
  const npmVersion = inspectNpmVersion(root);

  const version = verifyUndiciManifest(
    readJson(join(root, "node_modules", "undici", "package.json"), "npm bundled undici manifest"),
  );
  const affectedVersion = npmVersion === "12.2.1" ? "6.29.0" : AFFECTED_UNDICI_VERSION;
  if (version !== affectedVersion && version !== FIXED_UNDICI_VERSION) {
    throw new Error(`npm@${npmVersion} bundled undici identity has drifted`);
  }
  const nodeModulesRoot = realDirectory(join(root, "node_modules"), "npm node_modules root");
  const versions = collectBundledPackageVersions({
    ignoredDirectoryPrefixes: [".undici.nemoclaw-stage-", "undici.nemoclaw-backup-"],
    nodeModulesRoot,
    packageName: "undici",
  });
  if (versions.length !== 1 || versions[0] !== version) {
    throw new Error(`npm bundled undici layout has drifted: ${JSON.stringify(versions)}`);
  }

  return {
    undiciVersion: version,
    npmVersion,
    state: version === FIXED_UNDICI_VERSION ? "fixed" : "affected",
  };
}

export function verifyBundledNpmUndici(npmRoot: string): BundledNpmUndiciState {
  const inspected = inspectBundledNpmUndici(npmRoot);
  if (inspected.state !== "fixed") {
    throw new Error(
      `npm@${inspected.npmVersion} bundles affected undici@${inspected.undiciVersion}; expected ${FIXED_UNDICI_VERSION}`,
    );
  }
  return inspected;
}

export function patchBundledNpmUndici(options: {
  npmRoot: string;
  replacementRoot: string;
}): BundledNpmUndiciState {
  const npmRoot = realDirectory(options.npmRoot, "npm package root");
  const replacementRoot = realDirectory(options.replacementRoot, "replacement undici root");
  rejectUnsafePackageTree(replacementRoot, "replacement undici package");
  const replacementVersion = verifyUndiciManifest(
    readJson(join(replacementRoot, "package.json"), "replacement undici manifest"),
  );
  if (replacementVersion !== FIXED_UNDICI_VERSION) {
    throw new Error(`replacement package must be undici@${FIXED_UNDICI_VERSION}`);
  }

  const current = inspectForPatch(npmRoot);
  if (current.state === "fixed") return current;

  return replaceBundledPackage({
    npmRoot,
    packageName: "undici",
    replacementRoot,
    verify: verifyBundledNpmUndici,
  });
}

export type BundledNpmUndiciCommandRunner = BundledNpmCommandRunner;

type PreparedReplacement = PreparedBundledReplacement;

function prepareFixedUndiciReplacement(
  commandRunner: BundledNpmUndiciCommandRunner,
): PreparedReplacement {
  return prepareBundledPackageReplacement({
    packageName: "undici",
    version: FIXED_UNDICI_VERSION,
    integrity: FIXED_UNDICI_INTEGRITY,
    tarball: FIXED_UNDICI_TARBALL,
    offline: process.env.NPM_CONFIG_OFFLINE === "true" || process.env.npm_config_offline === "true",
    commandRunner,
  });
}

function inspectForPatch(npmRoot: string): BundledNpmUndiciState {
  const root = realDirectory(npmRoot, "npm package root");
  const npmVersion = inspectNpmVersion(root);
  const recovery = {
    npmRoot: root,
    packageName: "undici" as const,
    verifyBackup(manifest: JsonObject) {
      const affectedVersion = npmVersion === "12.2.1" ? "6.29.0" : AFFECTED_UNDICI_VERSION;
      if (verifyUndiciManifest(manifest) !== affectedVersion)
        throw new Error("retained backup identity has drifted");
    },
  };
  restoreMissingBundledPackage(recovery);
  const current = inspectBundledNpmUndici(root);
  reconcileBundledPackageBackup({ ...recovery, fixed: current.state === "fixed" });
  return current;
}

export type BundledNpmUndiciRegistryDependencies = Readonly<{
  commandRunner?: BundledNpmUndiciCommandRunner;
  prepareReplacement?: (commandRunner: BundledNpmUndiciCommandRunner) => PreparedReplacement;
}>;

export function patchBundledNpmUndiciFromRegistry(
  npmRoot: string,
  dependencies: BundledNpmUndiciRegistryDependencies = {},
): BundledNpmUndiciState {
  const current = inspectForPatch(npmRoot);
  return remediateBundledPackageFromRegistry({
    current,
    commandRunner: dependencies.commandRunner ?? runBundledNpmCommand,
    prepareReplacement: dependencies.prepareReplacement ?? prepareFixedUndiciReplacement,
    patch: (replacementRoot) => patchBundledNpmUndici({ npmRoot, replacementRoot }),
    verifyCommands(runner) {
      runner(process.execPath, [join(npmRoot, "bin", "npm-cli.js"), "--version"]);
      runner(process.execPath, [join(npmRoot, "bin", "npx-cli.js"), "--version"]);
    },
  });
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
    const result = patchBundledNpmUndiciFromRegistry(argument("--npm-root"));
    process.stdout.write(
      `Verified npm@${result.npmVersion} bundled undici@${result.undiciVersion}\n`,
    );
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
