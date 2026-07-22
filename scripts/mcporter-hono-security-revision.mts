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
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  commitStagedReplacementTransaction,
  discardStagedReplacements,
  type StagedReplacement,
  stageFileReplacement,
} from "./lib/staged-replacement-transaction.mts";

export const FIXED_HONO_NODE_SERVER_VERSION = "2.0.11";
export const FIXED_HONO_NODE_SERVER_INTEGRITY =
  "sha512-bjD221KPLoJTWUwso1J6fGKiTXEUFedG/s0visavY4zakFPkeGURMRNly+FhBHs7T8Dz4qHaZIMX9ZoJHSJtKA==";
export const FIXED_HONO_NODE_SERVER_TARBALL =
  "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.11.tgz";

const VULNERABLE_HONO_NODE_SERVER_VERSION = "1.19.14";
const VULNERABLE_HONO_NODE_SERVER_INTEGRITY =
  "sha512-GwtvgtXxnWsucXvbQXkRgqksiH2Qed37H9xHZocE5sA3N8O8O8/8FA3uclQXxXVzc9XBZuEOMK7+r02FmSpHtw==";
const VULNERABLE_HONO_NODE_SERVER_TARBALL =
  "https://registry.npmjs.org/@hono/node-server/-/node-server-1.19.14.tgz";
const BACKUP_MARKER = "nemoclaw-mcporter-hono-security-revision.json";

type JsonRecord = Record<string, unknown>;
type RevisionState = "fixed" | "vulnerable";

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function realDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${resolved}`);
  }
  return realpathSync(resolved);
}

function readRealFile(file: string, label: string): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a real file: ${file}: ${String(error)}`);
  }
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a real file: ${file}`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readJson(file: string, label: string): JsonRecord {
  try {
    return record(JSON.parse(readRealFile(file, label).toString("utf8")), label);
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error)}`);
  }
}

function jsonContents(value: JsonRecord): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function inspectMetadata(packageRoot: string): {
  lock: JsonRecord;
  manifest: JsonRecord;
  state: RevisionState;
} {
  const manifest = readJson(path.join(packageRoot, "package.json"), "mcporter runtime manifest");
  const lock = readJson(path.join(packageRoot, "package-lock.json"), "mcporter runtime lock");
  const manifestDependencies = record(manifest.dependencies, "mcporter runtime dependencies");
  const packages = record(lock.packages, "mcporter runtime lock packages");
  const rootLock = record(packages[""], "mcporter runtime root lock");
  const rootDependencies = record(rootLock.dependencies, "mcporter runtime root dependencies");
  const mcporterLock = record(packages["node_modules/mcporter"], "mcporter lock package");
  const sdkLock = record(
    packages["node_modules/@modelcontextprotocol/sdk"],
    "Model Context Protocol SDK lock package",
  );
  const sdkDependencies = record(
    sdkLock.dependencies,
    "Model Context Protocol SDK lock dependencies",
  );
  const honoLock = record(
    packages["node_modules/@hono/node-server"],
    "Hono node server lock package",
  );

  if (
    manifest.name !== "nemoclaw-mcporter-runtime" ||
    manifest.version !== "0.0.0" ||
    lock.name !== "nemoclaw-mcporter-runtime" ||
    lock.version !== "0.0.0" ||
    lock.lockfileVersion !== 3 ||
    rootLock.name !== "nemoclaw-mcporter-runtime" ||
    rootLock.version !== "0.0.0" ||
    manifestDependencies.mcporter !== "0.7.3" ||
    rootDependencies.mcporter !== "0.7.3" ||
    mcporterLock.version !== "0.7.3" ||
    sdkLock.version !== "1.29.0" ||
    sdkDependencies["@hono/node-server"] !== "^1.19.9"
  ) {
    throw new Error("historical mcporter dependency identity does not match the review");
  }

  const observed = {
    engine: record(honoLock.engines, "Hono node server engines").node,
    integrity: honoLock.integrity,
    overrides: manifest.overrides ?? null,
    resolved: honoLock.resolved,
    version: honoLock.version,
  };
  const vulnerable = {
    engine: ">=18.14.1",
    integrity: VULNERABLE_HONO_NODE_SERVER_INTEGRITY,
    overrides: null,
    resolved: VULNERABLE_HONO_NODE_SERVER_TARBALL,
    version: VULNERABLE_HONO_NODE_SERVER_VERSION,
  };
  const fixed = {
    engine: ">=20",
    integrity: FIXED_HONO_NODE_SERVER_INTEGRITY,
    overrides: { "@hono/node-server": FIXED_HONO_NODE_SERVER_VERSION },
    resolved: FIXED_HONO_NODE_SERVER_TARBALL,
    version: FIXED_HONO_NODE_SERVER_VERSION,
  };
  if (JSON.stringify(observed) === JSON.stringify(vulnerable)) {
    return { lock, manifest, state: "vulnerable" };
  }
  if (JSON.stringify(observed) === JSON.stringify(fixed)) {
    return { lock, manifest, state: "fixed" };
  }
  throw new Error(
    `historical mcporter Hono metadata is mixed or has drifted: ${JSON.stringify(observed)}`,
  );
}

function setFixedMetadata(manifest: JsonRecord, lock: JsonRecord): void {
  manifest.overrides = { "@hono/node-server": FIXED_HONO_NODE_SERVER_VERSION };
  const honoLock = record(
    record(lock.packages, "mcporter runtime lock packages")["node_modules/@hono/node-server"],
    "Hono node server lock package",
  );
  honoLock.version = FIXED_HONO_NODE_SERVER_VERSION;
  honoLock.resolved = FIXED_HONO_NODE_SERVER_TARBALL;
  honoLock.integrity = FIXED_HONO_NODE_SERVER_INTEGRITY;
  record(honoLock.engines, "Hono node server engines").node = ">=20";
}

function stageMetadata(
  packageRoot: string,
  manifest: JsonRecord | Buffer,
  lock: JsonRecord | Buffer,
  suffix = "",
): StagedReplacement[] {
  const replacements: StagedReplacement[] = [];
  try {
    replacements.push(
      stageFileReplacement({
        contents: Buffer.isBuffer(manifest) ? manifest : jsonContents(manifest),
        label: `mcporter runtime manifest${suffix}`,
        livePath: path.join(packageRoot, "package.json"),
      }),
      stageFileReplacement({
        contents: Buffer.isBuffer(lock) ? lock : jsonContents(lock),
        label: `mcporter runtime lock${suffix}`,
        livePath: path.join(packageRoot, "package-lock.json"),
      }),
    );
    return replacements;
  } catch (error) {
    discardStagedReplacements(replacements);
    throw error;
  }
}

function writeBackup(options: {
  backupDirectory: string;
  packageRoot: string;
  state: RevisionState;
}): void {
  const backupDirectory = realDirectory(options.backupDirectory, "backup directory");
  if (readdirSync(backupDirectory).length !== 0) throw new Error("backup directory must be empty");
  const rootMetadata = statSync(options.packageRoot);
  writeFileSync(
    path.join(backupDirectory, "package.json"),
    readRealFile(path.join(options.packageRoot, "package.json"), "mcporter runtime manifest"),
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(
    path.join(backupDirectory, "package-lock.json"),
    readRealFile(path.join(options.packageRoot, "package-lock.json"), "mcporter runtime lock"),
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(
    path.join(backupDirectory, BACKUP_MARKER),
    `${JSON.stringify({
      device: String(rootMetadata.dev),
      inode: String(rootMetadata.ino),
      packageRoot: realpathSync(options.packageRoot),
      schema: 1,
      state: options.state,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

export function prepareHistoricalMcporterInstall(options: {
  backupDirectory: string;
  packageRoot: string;
}): RevisionState {
  const packageRoot = realDirectory(options.packageRoot, "mcporter runtime root");
  const inspected = inspectMetadata(packageRoot);
  writeBackup({ ...options, packageRoot, state: inspected.state });
  if (inspected.state === "fixed") return inspected.state;

  setFixedMetadata(inspected.manifest, inspected.lock);
  const replacements = stageMetadata(packageRoot, inspected.manifest, inspected.lock);
  commitStagedReplacementTransaction({
    replacements,
    verify: () => {
      if (inspectMetadata(packageRoot).state !== "fixed") {
        throw new Error("mcporter Hono metadata revision did not reach the fixed state");
      }
    },
  });
  return inspected.state;
}

export function restoreHistoricalMcporterInstall(options: {
  backupDirectory: string;
  packageRoot: string;
}): void {
  const packageRoot = realDirectory(options.packageRoot, "mcporter runtime root");
  const backupDirectory = realDirectory(options.backupDirectory, "backup directory");
  const marker = readJson(path.join(backupDirectory, BACKUP_MARKER), "backup marker");
  const rootMetadata = statSync(packageRoot);
  if (
    marker.schema !== 1 ||
    marker.packageRoot !== packageRoot ||
    marker.device !== String(rootMetadata.dev) ||
    marker.inode !== String(rootMetadata.ino) ||
    (marker.state !== "vulnerable" && marker.state !== "fixed")
  ) {
    throw new Error("backup marker does not match the mcporter runtime root");
  }
  if (inspectMetadata(packageRoot).state !== "fixed") {
    throw new Error("refusing to restore over unexpected mcporter metadata");
  }
  const replacements = stageMetadata(
    packageRoot,
    readRealFile(path.join(backupDirectory, "package.json"), "backed-up mcporter manifest"),
    readRealFile(path.join(backupDirectory, "package-lock.json"), "backed-up mcporter lock"),
    " rollback",
  );
  commitStagedReplacementTransaction({
    replacements,
    verify: () => {
      if (inspectMetadata(packageRoot).state !== marker.state) {
        throw new Error("mcporter metadata rollback failed");
      }
    },
  });
}

export function verifyHistoricalMcporterInstall(packageRoot: string): void {
  const root = realDirectory(packageRoot, "mcporter runtime root");
  if (inspectMetadata(root).state !== "fixed")
    throw new Error("mcporter Hono metadata is not fixed");
  const installed = readJson(
    path.join(root, "node_modules", "@hono", "node-server", "package.json"),
    "installed Hono node server manifest",
  );
  if (
    installed.name !== "@hono/node-server" ||
    installed.version !== FIXED_HONO_NODE_SERVER_VERSION
  ) {
    throw new Error(
      `installed mcporter Hono package must be @hono/node-server@${FIXED_HONO_NODE_SERVER_VERSION}`,
    );
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function main(): void {
  const modes = ["--prepare-install", "--restore-install", "--verify-install"].filter((mode) =>
    process.argv.includes(mode),
  );
  if (modes.length !== 1) throw new Error("exactly one mcporter Hono revision mode is required");
  const packageRoot = argument("--mcporter-root");
  if (modes[0] === "--verify-install") {
    verifyHistoricalMcporterInstall(packageRoot);
    return;
  }
  const options = { backupDirectory: argument("--backup-directory"), packageRoot };
  if (modes[0] === "--prepare-install") prepareHistoricalMcporterInstall(options);
  else restoreHistoricalMcporterInstall(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
