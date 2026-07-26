#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { remediateReviewedOpenClawPluginArchive } from "./lib/openclaw-npm-remediation.mts";
import {
  packReviewedNpmArchive,
  verifyInstalledNpmLock,
  verifyReviewedNpmLock,
} from "./lib/reviewed-npm-archive.mts";
import {
  assertExceptionGraphs,
  readAuditExceptionRegistry,
  runReviewedNpmAudit,
  type Severity,
} from "./lib/reviewed-npm-audit.mts";

type ReviewedPackage = Readonly<{
  integrity: string;
  label: string;
  packageSpec: string;
  tarballUrl: string;
}>;
type LockedGraph = ReviewedPackage &
  Readonly<{ directory: string; id: string; lockSha256: string }>;
type AuditConfig = Readonly<{
  archivePackages: readonly ReviewedPackage[];
  archiveGraphId: string;
  artifactDirectory: string;
  exceptionFile: string;
  lockedGraphs: readonly LockedGraph[];
  nodeVersion: string;
  registryOrigin: string;
  schemaVersion: 2;
  severityThreshold: Severity;
}>;

const TRUSTED_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_REPO_ROOT = fs.realpathSync(
  path.resolve(process.env.NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT ?? TRUSTED_REPO_ROOT),
);
const CONFIG_PATH = resolveTrustedAuditConfigPath(TRUSTED_REPO_ROOT);
const SEVERITIES: readonly Severity[] = ["info", "low", "moderate", "high", "critical"];
const OPENCLAW_DOMEXCEPTION_ALIAS = {
  actualName: "@nolyfill/domexception",
  aliasPackagePath: "node_modules/openclaw/node_modules/node-domexception",
  actualPackagePath: "node_modules/openclaw/node_modules/@nolyfill/domexception",
  integrity:
    "sha512-tlc/FcYIv5i8RYsl2iDil4A0gOihaas1R5jPcIC4Zw3GhjKsVilw90aHcVlhZPTBLGBzd379S+VcnsDjd9ChiA==",
  requesterPackagePath: "node_modules/openclaw/node_modules/fetch-blob",
  requestedRange: "^1.0.0",
  resolved: "https://registry.npmjs.org/@nolyfill/domexception/-/domexception-1.0.28.tgz",
  version: "1.0.28",
} as const;

export function resolvePathWithinRoot(root: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a nonempty relative path`);
  }
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const resolved = path.resolve(canonicalRoot, relativePath);
  if (!resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error(`${label} escapes its repository root: ${relativePath}`);
  }
  let current = canonicalRoot;
  for (const component of path.relative(canonicalRoot, resolved).split(path.sep)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic-link component: ${relativePath}`);
    }
  }
  return resolved;
}

export function resolveTrustedAuditConfigPath(trustedRoot: string): string {
  return resolvePathWithinRoot(
    trustedRoot,
    "ci/reviewed-npm-audit.json",
    "trusted reviewed npm audit configuration",
  );
}

function trustedRepositoryPath(relativePath: string, label: string): string {
  return resolvePathWithinRoot(TRUSTED_REPO_ROOT, relativePath, label);
}

function targetRepositoryPath(relativePath: string, label: string): string {
  return resolvePathWithinRoot(TARGET_REPO_ROOT, relativePath, label);
}

function run(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function readConfig(): AuditConfig {
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as AuditConfig;
  if (
    parsed.schemaVersion !== 2 ||
    !SEVERITIES.includes(parsed.severityThreshold) ||
    typeof parsed.archiveGraphId !== "string" ||
    !parsed.archiveGraphId ||
    typeof parsed.exceptionFile !== "string" ||
    !parsed.exceptionFile ||
    typeof parsed.registryOrigin !== "string" ||
    !parsed.registryOrigin ||
    !Array.isArray(parsed.archivePackages) ||
    !Array.isArray(parsed.lockedGraphs) ||
    parsed.lockedGraphs.some(
      (graph) =>
        typeof graph.id !== "string" ||
        !graph.id ||
        typeof graph.directory !== "string" ||
        !graph.directory ||
        typeof graph.lockSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(graph.lockSha256),
    )
  ) {
    throw new Error("ci/reviewed-npm-audit.json is invalid");
  }
  return parsed;
}

function materializeArchiveGraph(packages: readonly ReviewedPackage[], tempRoot: string): string {
  const graphDirectory = path.join(tempRoot, "reviewed-archive-graph");
  fs.mkdirSync(graphDirectory);
  fs.writeFileSync(
    path.join(graphDirectory, "package.json"),
    `${JSON.stringify({ name: "nemoclaw-reviewed-production-graph", private: true, version: "1.0.0" }, null, 2)}\n`,
  );
  const archives = packages.map((reviewed) => {
    const archive = packReviewedNpmArchive({
      expectedIntegrity: reviewed.integrity,
      label: reviewed.label,
      packageSpec: reviewed.packageSpec,
      tarballUrl: reviewed.tarballUrl,
      tempDirectory: tempRoot,
    });
    return remediateReviewedOpenClawPluginArchive({
      archivePath: archive.archivePath,
      packageSpec: reviewed.packageSpec,
      workingDirectory: archive.rootDirectory,
    });
  });
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      ...archives.map((archive) => archive.archivePath),
    ],
    graphDirectory,
  );
  return graphDirectory;
}

function materializeLockedGraph(
  graph: LockedGraph,
  tempRoot: string,
  registryOrigin: string,
): string {
  const sourcePackage = targetRepositoryPath(
    path.join(graph.directory, "package.json"),
    `${graph.label} package manifest`,
  );
  const sourceLock = targetRepositoryPath(
    path.join(graph.directory, "package-lock.json"),
    `${graph.label} lockfile`,
  );
  verifyReviewedNpmLock({
    expectedIntegrity: graph.integrity,
    expectedLockSha256: graph.lockSha256,
    label: graph.label,
    lockfilePath: sourceLock,
    packageSpec: graph.packageSpec,
    registryOrigin,
    tarballUrl: graph.tarballUrl,
  });
  const destination = path.join(tempRoot, `locked-${path.basename(graph.directory)}`);
  fs.mkdirSync(destination);
  fs.copyFileSync(sourcePackage, path.join(destination, "package.json"));
  fs.copyFileSync(sourceLock, path.join(destination, "package-lock.json"));
  run("npm", ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], destination);
  verifyInstalledNpmLock({
    expectedLockSha256: graph.lockSha256,
    installRoot: destination,
    label: graph.label,
    lockfilePath: path.join(destination, "package-lock.json"),
  });
  return destination;
}

function readJsonObject(file: string, label: string): Record<string, any> {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, any>;
}

function assertRegularFile(file: string, label: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
}

export function normalizeOpenClawSignatureAlias(directory: string): void {
  const {
    actualName,
    actualPackagePath,
    aliasPackagePath,
    integrity,
    requesterPackagePath,
    requestedRange,
    resolved,
    version,
  } = OPENCLAW_DOMEXCEPTION_ALIAS;
  const lockfile = path.join(directory, "package-lock.json");
  const aliasDirectory = path.join(directory, aliasPackagePath);
  const actualDirectory = path.join(directory, actualPackagePath);
  const aliasManifestFile = path.join(aliasDirectory, "package.json");
  const requesterManifestFile = path.join(directory, requesterPackagePath, "package.json");
  for (const [file, label] of [
    [lockfile, "OpenClaw signature-audit lock"],
    [aliasManifestFile, "OpenClaw aliased package manifest"],
    [requesterManifestFile, "OpenClaw alias requester manifest"],
  ] as const) {
    assertRegularFile(file, label);
  }
  if (fs.existsSync(actualDirectory)) {
    throw new Error(`OpenClaw signature-audit destination already exists: ${actualPackagePath}`);
  }

  const lock = readJsonObject(lockfile, "OpenClaw signature-audit lock");
  const packages = lock.packages as Record<string, any> | undefined;
  const aliasEntry = packages?.[aliasPackagePath];
  const requesterEntry = packages?.[requesterPackagePath];
  if (
    !packages ||
    !aliasEntry ||
    aliasEntry.name !== actualName ||
    aliasEntry.version !== version ||
    aliasEntry.resolved !== resolved ||
    aliasEntry.integrity !== integrity ||
    packages[actualPackagePath] ||
    requesterEntry?.dependencies?.["node-domexception"] !== requestedRange ||
    requesterEntry.dependencies[actualName] !== undefined
  ) {
    throw new Error("OpenClaw signature-audit alias lock identity drifted");
  }
  const aliasManifest = readJsonObject(aliasManifestFile, "OpenClaw aliased package manifest");
  const requesterManifest = readJsonObject(
    requesterManifestFile,
    "OpenClaw alias requester manifest",
  );
  if (
    aliasManifest.name !== actualName ||
    aliasManifest.version !== version ||
    requesterManifest.dependencies?.["node-domexception"] !== requestedRange ||
    requesterManifest.dependencies?.[actualName] !== undefined
  ) {
    throw new Error("OpenClaw signature-audit installed alias identity drifted");
  }

  packages[actualPackagePath] = aliasEntry;
  delete packages[aliasPackagePath];
  delete requesterEntry.dependencies["node-domexception"];
  requesterEntry.dependencies[actualName] = version;
  delete requesterManifest.dependencies["node-domexception"];
  requesterManifest.dependencies[actualName] = version;
  fs.mkdirSync(path.dirname(actualDirectory), { recursive: true });
  fs.renameSync(aliasDirectory, actualDirectory);
  fs.writeFileSync(lockfile, `${JSON.stringify(lock, null, 2)}\n`);
  fs.writeFileSync(requesterManifestFile, `${JSON.stringify(requesterManifest, null, 2)}\n`);
}

function auditLockedGraph(
  graph: LockedGraph,
  index: number,
  config: AuditConfig,
  tempRoot: string,
  exceptionFile: string,
  artifactDirectory: string,
  npmVersion: string,
) {
  const directory = materializeLockedGraph(graph, tempRoot, config.registryOrigin);
  const result = runReviewedNpmAudit({
    directory,
    exceptionFile,
    graph: graph.id,
    provenance: {
      label: graph.label,
      nodeVersion: process.version,
      npmVersion,
      packageSpecs: [graph.packageSpec],
    },
    reportFile: path.join(artifactDirectory, `locked-graph-${index + 1}.json`),
    resultFile: path.join(artifactDirectory, `locked-graph-${index + 1}-policy.json`),
    threshold: config.severityThreshold,
    throwOnBlock: false,
  });
  if (graph.id === "openclaw-runtime") {
    normalizeOpenClawSignatureAlias(directory);
  }
  run("npm", ["audit", "signatures", "--omit=dev"], directory);
  return result;
}

function main(): void {
  const config = readConfig();
  const expectedNode = `v${config.nodeVersion}`;
  if (process.version !== expectedNode) {
    throw new Error(`reviewed npm audit requires Node ${expectedNode}; running ${process.version}`);
  }
  const artifactDirectory = targetRepositoryPath(
    process.env.NEMOCLAW_REVIEWED_NPM_AUDIT_REPORT_DIR ?? config.artifactDirectory,
    "audit artifact directory",
  );
  const exceptionFile = trustedRepositoryPath(config.exceptionFile, "npm audit exception file");
  const exceptionRegistry = readAuditExceptionRegistry(exceptionFile);
  assertExceptionGraphs(
    exceptionRegistry.policy,
    new Set([config.archiveGraphId, ...config.lockedGraphs.map((graph) => graph.id)]),
  );
  fs.rmSync(artifactDirectory, { recursive: true, force: true });
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const npmVersion = run("npm", ["--version"], TRUSTED_REPO_ROOT).stdout.trim();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-audit-"));
  try {
    const reports = [
      {
        label: "reviewed archive graph",
        result: runReviewedNpmAudit({
          directory: materializeArchiveGraph(config.archivePackages, tempRoot),
          exceptionFile,
          graph: config.archiveGraphId,
          provenance: {
            label: "reviewed archive graph",
            nodeVersion: process.version,
            npmVersion,
            packageSpecs: config.archivePackages.map((reviewed) => reviewed.packageSpec),
          },
          reportFile: path.join(artifactDirectory, "reviewed-archive-graph.json"),
          resultFile: path.join(artifactDirectory, "reviewed-archive-graph-policy.json"),
          threshold: config.severityThreshold,
          throwOnBlock: false,
        }),
      },
      ...config.lockedGraphs.map((graph, index) => ({
        label: graph.label,
        result: auditLockedGraph(
          graph,
          index,
          config,
          tempRoot,
          exceptionFile,
          artifactDirectory,
          npmVersion,
        ),
      })),
    ];
    const failures: string[] = [];
    for (const { label, result } of reports) {
      if (result.unacceptedBlockingAdvisories.length > 0) {
        failures.push(
          `${label}: ${result.unacceptedBlockingAdvisories.length} unaccepted at or above ${config.severityThreshold}`,
        );
      }
    }
    if (failures.length > 0)
      throw new Error(`reviewed npm audit threshold failed\n${failures.join("\n")}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function isMainModule(): boolean {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    : false;
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
