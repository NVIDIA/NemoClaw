#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync } from "node:fs";
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

export const AFFECTED_IP_ADDRESS_VERSION = "10.2.0";
export const FIXED_IP_ADDRESS_VERSION = "10.3.1";
export const FIXED_IP_ADDRESS_INTEGRITY =
  "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==";
export const FIXED_IP_ADDRESS_TARBALL =
  "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz";

const REVIEWED_IP_ADDRESS_VERSIONS = new Set([
  AFFECTED_IP_ADDRESS_VERSION,
  FIXED_IP_ADDRESS_VERSION,
]);

function verifyIpAddressManifest(manifest: JsonObject): string {
  const version = manifest.version;
  const engines = record(manifest.engines, "npm bundled ip-address engines");
  if (
    manifest.name !== "ip-address" ||
    typeof version !== "string" ||
    !REVIEWED_IP_ADDRESS_VERSIONS.has(version) ||
    manifest.main !== "dist/ip-address.js" ||
    manifest.types !== "dist/ip-address.d.ts" ||
    manifest.license !== "MIT" ||
    engines.node !== ">= 12" ||
    manifest.dependencies !== undefined
  ) {
    throw new Error(
      `npm bundled ip-address identity or package contract has drifted: ${JSON.stringify({
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

export type BundledNpmIpAddressState = Readonly<{
  ipAddressVersion: string;
  npmVersion: string;
  state: "affected" | "fixed";
}>;

function inspectNpmVersion(root: string): string {
  const npmManifest = readJson(join(root, "package.json"), "npm package manifest");
  if (npmManifest.name !== "npm" || npmManifest.version !== REVIEWED_NPM_VERSION) {
    throw new Error(`npm package identity has drifted; expected npm@${REVIEWED_NPM_VERSION}`);
  }

  return REVIEWED_NPM_VERSION;
}

export function inspectBundledNpmIpAddress(npmRoot: string): BundledNpmIpAddressState {
  const root = realDirectory(npmRoot, "npm package root");
  const npmVersion = inspectNpmVersion(root);

  const version = verifyIpAddressManifest(
    readJson(
      join(root, "node_modules", "ip-address", "package.json"),
      "npm bundled ip-address manifest",
    ),
  );
  const nodeModulesRoot = realDirectory(join(root, "node_modules"), "npm node_modules root");
  const versions = collectBundledPackageVersions({
    ignoredDirectoryPrefixes: [".ip-address.nemoclaw-stage-", "ip-address.nemoclaw-backup-"],
    nodeModulesRoot,
    packageName: "ip-address",
  });
  if (versions.length !== 1 || versions[0] !== version) {
    throw new Error(`npm bundled ip-address layout has drifted: ${JSON.stringify(versions)}`);
  }

  return {
    ipAddressVersion: version,
    npmVersion,
    state: version === FIXED_IP_ADDRESS_VERSION ? "fixed" : "affected",
  };
}

export function verifyBundledNpmIpAddress(npmRoot: string): BundledNpmIpAddressState {
  const inspected = inspectBundledNpmIpAddress(npmRoot);
  if (inspected.state !== "fixed") {
    throw new Error(
      `npm@${inspected.npmVersion} bundles affected ip-address@${inspected.ipAddressVersion}; expected ${FIXED_IP_ADDRESS_VERSION}`,
    );
  }
  return inspected;
}

export function patchBundledNpmIpAddress(options: {
  npmRoot: string;
  replacementRoot: string;
}): BundledNpmIpAddressState {
  const npmRoot = realDirectory(options.npmRoot, "npm package root");
  const replacementRoot = realDirectory(options.replacementRoot, "replacement ip-address root");
  rejectUnsafePackageTree(replacementRoot, "replacement ip-address package");
  const replacementVersion = verifyIpAddressManifest(
    readJson(join(replacementRoot, "package.json"), "replacement ip-address manifest"),
  );
  if (replacementVersion !== FIXED_IP_ADDRESS_VERSION) {
    throw new Error(`replacement package must be ip-address@${FIXED_IP_ADDRESS_VERSION}`);
  }

  const current = inspectForPatch(npmRoot);
  if (current.state === "fixed") return current;

  return replaceBundledPackage({
    npmRoot,
    packageName: "ip-address",
    replacementRoot,
    verify: verifyReadableBundledNpmIpAddress,
  });
}

export type BundledNpmIpAddressCommandRunner = BundledNpmCommandRunner;

type PreparedReplacement = PreparedBundledReplacement;

function prepareFixedIpAddressReplacement(
  commandRunner: BundledNpmIpAddressCommandRunner,
): PreparedReplacement {
  return prepareBundledPackageReplacement({
    packageName: "ip-address",
    version: FIXED_IP_ADDRESS_VERSION,
    integrity: FIXED_IP_ADDRESS_INTEGRITY,
    tarball: FIXED_IP_ADDRESS_TARBALL,
    offline: false,
    commandRunner,
  });
}

function verifyReadableBundledNpmIpAddress(npmRoot: string): BundledNpmIpAddressState {
  const fixed = verifyBundledNpmIpAddress(npmRoot);
  // Keep the installed package readable while the replacement transaction stays private.
  chmodSync(
    realDirectory(join(npmRoot, "node_modules", "ip-address"), "npm bundled ip-address root"),
    0o755,
  );
  return fixed;
}

function inspectForPatch(npmRoot: string): BundledNpmIpAddressState {
  const root = realDirectory(npmRoot, "npm package root");
  inspectNpmVersion(root);
  const recovery = {
    npmRoot: root,
    packageName: "ip-address" as const,
    verifyBackup(manifest: JsonObject) {
      const affectedVersion = AFFECTED_IP_ADDRESS_VERSION;
      if (verifyIpAddressManifest(manifest) !== affectedVersion)
        throw new Error("retained backup identity has drifted");
    },
  };
  restoreMissingBundledPackage(recovery);
  const current = inspectBundledNpmIpAddress(root);
  reconcileBundledPackageBackup({ ...recovery, fixed: current.state === "fixed" });
  if (current.state === "fixed") return verifyReadableBundledNpmIpAddress(root);
  return current;
}

export type BundledNpmIpAddressRegistryDependencies = Readonly<{
  commandRunner?: BundledNpmIpAddressCommandRunner;
  prepareReplacement?: (commandRunner: BundledNpmIpAddressCommandRunner) => PreparedReplacement;
}>;

export function patchBundledNpmIpAddressFromRegistry(
  npmRoot: string,
  dependencies: BundledNpmIpAddressRegistryDependencies = {},
): BundledNpmIpAddressState {
  const current = inspectForPatch(npmRoot);
  return remediateBundledPackageFromRegistry({
    current,
    commandRunner: dependencies.commandRunner ?? runBundledNpmCommand,
    prepareReplacement: dependencies.prepareReplacement ?? prepareFixedIpAddressReplacement,
    patch: (replacementRoot) => patchBundledNpmIpAddress({ npmRoot, replacementRoot }),
    verifyCommands(runner) {
      runner("npm", ["--version"]);
      runner("npx", ["--version"]);
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
    const result = patchBundledNpmIpAddressFromRegistry(argument("--npm-root"));
    process.stdout.write(
      `Verified npm@${result.npmVersion} bundled ip-address@${result.ipAddressVersion}\n`,
    );
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
