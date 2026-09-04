#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { remediateReviewedOpenClawPluginArchive } from "./lib/openclaw-npm-remediation.mts";
import { canonicalAuditReceipt, createAuditReceipt } from "./lib/npm-audit-receipt.mts";
import {
  packReviewedNpmArchive,
  verifyInstalledNpmLock,
  verifyReviewedNpmLock,
  verifyReviewedNpmLockPackages,
} from "./lib/reviewed-npm-archive.mts";
import {
  type AuditPolicyResult,
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
type SourceRegistryPackage = ReviewedPackage & Readonly<{ artifactName: string }>;
type PackageWithoutIntegrity = Readonly<{
  label: string;
  packageSpec: string;
  tarballUrl: string;
}>;
type LockedGraph = ReviewedPackage &
  Readonly<{
    directory: string;
    id: string;
    inputValidation?: "wechat-runtime";
    installMode?: "legacy-peer-deps";
    lockSha256: string;
    replacementLockSha256?: string;
    severityThreshold?: Severity;
    signatureAudit?: "retry-download-failures";
  }>;
type AuditConfig = Readonly<{
  archivePackages: readonly ReviewedPackage[];
  archiveGraphId: string;
  archiveTarVersion: "7.5.21";
  artifactDirectory: string;
  exceptionFile: string;
  lockedGraphs: readonly LockedGraph[];
  nodeVersion: string;
  registryOrigin: string;
  schemaVersion: 2;
  severityThreshold: Severity;
  sourceNestedShrinkwrapPackages: readonly string[];
  sourceRegistryPackage: SourceRegistryPackage;
  sourceRegistryPackagesWithoutIntegrity: readonly PackageWithoutIntegrity[];
}>;
type ReviewedAuditReport = Readonly<{
  label: string;
  result: AuditPolicyResult;
  threshold?: Severity;
}>;

const TRUSTED_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_REPO_ROOT = fs.realpathSync(
  path.resolve(process.env.NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT ?? TRUSTED_REPO_ROOT),
);
const CONFIG_PATH = resolveTrustedAuditConfigPath(TRUSTED_REPO_ROOT);
const SEVERITIES: readonly Severity[] = ["info", "low", "moderate", "high", "critical"];
const SEMVER_NUMERIC_IDENTIFIER = String.raw`(?:0|[1-9][0-9]*)`;
const SEMVER_PRERELEASE_IDENTIFIER = String.raw`(?:${SEMVER_NUMERIC_IDENTIFIER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const EXACT_NPM_PACKAGE_SPEC = new RegExp(
  String.raw`^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@${SEMVER_NUMERIC_IDENTIFIER}\.${SEMVER_NUMERIC_IDENTIFIER}\.${SEMVER_NUMERIC_IDENTIFIER}(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\.${SEMVER_PRERELEASE_IDENTIFIER})*)?$`,
);
const SOURCE_GRAPH = {
  id: "nemoclaw-cli",
  label: "NemoClaw CLI locked production graph",
} as const;
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

function graphCacheFile(graphId: string): string | undefined {
  const configuredDirectory = process.env.NEMOCLAW_REVIEWED_NPM_AUDIT_CACHE_DIR;
  if (!configuredDirectory) return undefined;
  if (!path.isAbsolute(configuredDirectory)) {
    throw new Error("reviewed npm audit cache directory must be absolute");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(graphId)) {
    throw new Error(`npm audit cache graph ID is unsafe: ${graphId}`);
  }
  const directory = path.resolve(configuredDirectory);
  let current = path.parse(directory).root;
  for (const component of path.relative(current, directory).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new Error("reviewed npm audit cache directory must exist");
    if (stat.isSymbolicLink()) {
      throw new Error("reviewed npm audit cache directory must not contain symbolic links");
    }
  }
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error("reviewed npm audit cache directory must be a directory");
  }
  return path.join(directory, `${graphId}.json`);
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

export function parseAuditConfig(contents: string): AuditConfig {
  const parsed = JSON.parse(contents) as AuditConfig;
  if (
    parsed.schemaVersion !== 2 ||
    !SEVERITIES.includes(parsed.severityThreshold) ||
    typeof parsed.archiveGraphId !== "string" ||
    !parsed.archiveGraphId ||
    parsed.archiveTarVersion !== "7.5.21" ||
    typeof parsed.exceptionFile !== "string" ||
    !parsed.exceptionFile ||
    typeof parsed.registryOrigin !== "string" ||
    !parsed.registryOrigin ||
    !Array.isArray(parsed.archivePackages) ||
    !Array.isArray(parsed.lockedGraphs) ||
    !Array.isArray(parsed.sourceNestedShrinkwrapPackages) ||
    parsed.sourceNestedShrinkwrapPackages.some(
      (packageSpec) => typeof packageSpec !== "string" || !EXACT_NPM_PACKAGE_SPEC.test(packageSpec),
    ) ||
    new Set(parsed.sourceNestedShrinkwrapPackages).size !==
      parsed.sourceNestedShrinkwrapPackages.length ||
    !Array.isArray(parsed.sourceRegistryPackagesWithoutIntegrity) ||
    parsed.sourceRegistryPackagesWithoutIntegrity.some(
      (reviewed) =>
        typeof reviewed.label !== "string" ||
        !reviewed.label ||
        typeof reviewed.packageSpec !== "string" ||
        !EXACT_NPM_PACKAGE_SPEC.test(reviewed.packageSpec) ||
        typeof reviewed.tarballUrl !== "string" ||
        !reviewed.tarballUrl,
    ) ||
    new Set(parsed.sourceRegistryPackagesWithoutIntegrity.map(({ packageSpec }) => packageSpec))
      .size !== parsed.sourceRegistryPackagesWithoutIntegrity.length ||
    typeof parsed.sourceRegistryPackage !== "object" ||
    parsed.sourceRegistryPackage === null ||
    Array.isArray(parsed.sourceRegistryPackage) ||
    typeof parsed.sourceRegistryPackage.artifactName !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*\.tgz$/.test(parsed.sourceRegistryPackage.artifactName) ||
    typeof parsed.sourceRegistryPackage.label !== "string" ||
    !parsed.sourceRegistryPackage.label ||
    typeof parsed.sourceRegistryPackage.packageSpec !== "string" ||
    !EXACT_NPM_PACKAGE_SPEC.test(parsed.sourceRegistryPackage.packageSpec) ||
    typeof parsed.sourceRegistryPackage.integrity !== "string" ||
    !parsed.sourceRegistryPackage.integrity ||
    typeof parsed.sourceRegistryPackage.tarballUrl !== "string" ||
    !parsed.sourceRegistryPackage.tarballUrl ||
    parsed.lockedGraphs.some(
      (graph) =>
        typeof graph.id !== "string" ||
        !graph.id ||
        typeof graph.directory !== "string" ||
        !graph.directory ||
        typeof graph.lockSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(graph.lockSha256) ||
        (graph.inputValidation !== undefined && graph.inputValidation !== "wechat-runtime") ||
        (graph.installMode !== undefined && graph.installMode !== "legacy-peer-deps") ||
        (graph.severityThreshold !== undefined && !SEVERITIES.includes(graph.severityThreshold)) ||
        (graph.signatureAudit !== undefined &&
          graph.signatureAudit !== "retry-download-failures") ||
        (graph.inputValidation === "wechat-runtime" &&
          (graph.id !== "wechat-runtime" ||
            graph.installMode !== "legacy-peer-deps" ||
            graph.severityThreshold !== "low" ||
            graph.signatureAudit !== "retry-download-failures")) ||
        (graph.inputValidation !== "wechat-runtime" &&
          (graph.installMode !== undefined ||
            graph.severityThreshold !== undefined ||
            graph.signatureAudit !== undefined)) ||
        (graph.replacementLockSha256 !== undefined &&
          (typeof graph.replacementLockSha256 !== "string" ||
            !/^[0-9a-f]{64}$/.test(graph.replacementLockSha256) ||
            graph.replacementLockSha256 === graph.lockSha256)),
    ) ||
    new Set(parsed.lockedGraphs.map(({ id }) => id)).size !== parsed.lockedGraphs.length
  ) {
    throw new Error("ci/reviewed-npm-audit.json is invalid");
  }
  return parsed;
}

function readConfig(): AuditConfig {
  return parseAuditConfig(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

export function reviewedArchiveGraphManifest(archiveTarVersion: unknown) {
  if (archiveTarVersion !== "7.5.21") {
    throw new Error("reviewed archive graph tar version must be exactly 7.5.21");
  }
  return {
    name: "nemoclaw-reviewed-production-graph",
    overrides: { tar: archiveTarVersion },
    private: true,
    version: "1.0.0",
  } as const;
}

function materializeArchiveGraph(
  packages: readonly ReviewedPackage[],
  tempRoot: string,
  archiveTarVersion: "7.5.21",
): string {
  const graphDirectory = path.join(tempRoot, "reviewed-archive-graph");
  fs.mkdirSync(graphDirectory);
  fs.writeFileSync(
    path.join(graphDirectory, "package.json"),
    `${JSON.stringify(reviewedArchiveGraphManifest(archiveTarVersion), null, 2)}\n`,
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

export function validateWechatRuntimeInputs(
  packageFile: string,
  lockFile: string,
  registryOrigin: string,
): void {
  const manifest = readJsonObject(packageFile, "WeChat runtime package manifest");
  const lock = readJsonObject(lockFile, "WeChat runtime lockfile");
  const dependencies = manifest.dependencies as Record<string, unknown> | undefined;
  const names = dependencies ? Object.keys(dependencies) : [];
  if (names.length !== 1 || names[0] !== "@tencent-weixin/openclaw-weixin") {
    throw new Error(
      "WeChat runtime package manifest must contain exactly the reviewed plugin dependency",
    );
  }
  const version = dependencies?.[names[0]!];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("WeChat runtime dependency must use an exact numeric version");
  }
  if (lock.lockfileVersion !== 3) throw new Error("WeChat runtime lockfileVersion must be 3");
  const packages = lock.packages as Record<string, any> | undefined;
  const plugin = packages?.["node_modules/@tencent-weixin/openclaw-weixin"];
  if (packages?.[""]?.dependencies?.[names[0]!] !== version || plugin?.version !== version) {
    throw new Error("WeChat runtime package and lock identities do not match");
  }
  if (typeof plugin.integrity !== "string" || !plugin.integrity.startsWith("sha512-")) {
    throw new Error("WeChat runtime plugin lock entry must carry sha512 integrity");
  }
  if (typeof plugin.peerDependencies?.openclaw !== "string" || !plugin.peerDependencies.openclaw) {
    throw new Error("WeChat runtime plugin lock entry must declare its OpenClaw peer range");
  }
  const expectedOrigin = new URL(registryOrigin).origin;
  for (const [location, record] of Object.entries(packages ?? {})) {
    if (!location.startsWith("node_modules/")) continue;
    if (typeof record.version !== "string" || typeof record.integrity !== "string") {
      throw new Error(`locked package lacks version or integrity: ${location}`);
    }
    let resolved: URL;
    try {
      resolved = new URL(record.resolved);
    } catch {
      throw new Error(`locked package has an invalid resolved URL: ${location}`);
    }
    if (resolved.origin !== expectedOrigin || resolved.username || resolved.password) {
      throw new Error(
        `locked package must resolve from the reviewed npm registry origin: ${location}`,
      );
    }
  }
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
  if (graph.inputValidation === "wechat-runtime") {
    for (const npmrc of [
      targetRepositoryPath(".npmrc", "target npm config"),
      targetRepositoryPath(path.join(graph.directory, ".npmrc"), "runtime npm config"),
    ]) {
      if (
        fs.existsSync(npmrc) ||
        fs.lstatSync(npmrc, { throwIfNoEntry: false })?.isSymbolicLink()
      ) {
        throw new Error(`WeChat runtime audit refuses target-controlled npm config: ${npmrc}`);
      }
    }
    validateWechatRuntimeInputs(sourcePackage, sourceLock, registryOrigin);
  }
  const expectedLockSha256 = selectReviewedLockSha256(
    sourceLock,
    graph.lockSha256,
    graph.replacementLockSha256,
    graph.label,
  );
  verifyReviewedNpmLock({
    expectedIntegrity: graph.integrity,
    expectedLockSha256,
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
  const installArgs = ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"];
  if (graph.installMode === "legacy-peer-deps") installArgs.push("--legacy-peer-deps");
  run("npm", installArgs, destination);
  verifyMaterializedLockedGraph({ destination, expectedLockSha256, label: graph.label });
  return destination;
}

export function verifyMaterializedLockedGraph({
  destination,
  expectedLockSha256,
  label,
}: Readonly<{
  destination: string;
  expectedLockSha256: string;
  label: string;
}>): readonly string[] {
  const lockfilePath = path.join(destination, "package-lock.json");
  return verifyInstalledNpmLock({
    expectedLockSha256,
    installRoot: destination,
    label,
    lockfilePath,
    omitDev: true,
  });
}

export function selectReviewedLockSha256(
  lockfilePath: string,
  lockSha256: string,
  replacementLockSha256: string | undefined,
  label: string,
): string {
  const actual = createHash("sha256").update(fs.readFileSync(lockfilePath)).digest("hex");
  const reviewedDigests =
    replacementLockSha256 === undefined ? [lockSha256] : [lockSha256, replacementLockSha256];
  if (!reviewedDigests.includes(actual)) {
    throw new Error(
      `${label} lock SHA-256 mismatch\nExpected one of: ${reviewedDigests.join(", ")}\nActual:          ${actual}`,
    );
  }
  return actual;
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

function installProductionSourceDependencies(directory: string): void {
  run("npm", ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], directory);
}

export function materializeSourceGraph(
  sourcePackage: string,
  sourceLock: string,
  destination: string,
  registryOrigin: string,
  installProductionDependencies: (directory: string) => void = installProductionSourceDependencies,
  sourceRegistryPackage?: ReviewedPackage,
  sourceNestedShrinkwrapPackages: readonly string[] = [],
  sourceRegistryPackagesWithoutIntegrity: readonly PackageWithoutIntegrity[] = [],
): string {
  assertRegularFile(sourcePackage, "NemoClaw CLI package manifest");
  assertRegularFile(sourceLock, "NemoClaw CLI lockfile");
  verifyReviewedNpmLockPackages({
    allowedNestedShrinkwrapPackages: sourceNestedShrinkwrapPackages,
    lockfilePath: sourceLock,
    omitDev: true,
    registryOrigin,
    reviewedRegistryPackages: sourceRegistryPackage
      ? [
          {
            expectedIntegrity: sourceRegistryPackage.integrity,
            label: sourceRegistryPackage.label,
            packageSpec: sourceRegistryPackage.packageSpec,
            tarballUrl: sourceRegistryPackage.tarballUrl,
          },
        ]
      : [],
    reviewedPackagesWithoutIntegrity: sourceRegistryPackagesWithoutIntegrity,
  });
  const lockSha256 = createHash("sha256").update(fs.readFileSync(sourceLock)).digest("hex");
  fs.mkdirSync(destination);
  fs.copyFileSync(sourcePackage, path.join(destination, "package.json"));
  const installedLock = path.join(destination, "package-lock.json");
  fs.copyFileSync(sourceLock, installedLock);
  installProductionDependencies(destination);
  verifyInstalledNpmLock({
    expectedLockSha256: lockSha256,
    installRoot: destination,
    label: SOURCE_GRAPH.label,
    lockfilePath: installedLock,
    omitDev: true,
  });
  return destination;
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

type CommandResult = Readonly<{ status: number | null; stdout: string; stderr: string }>;

export function verifySignaturesWithReviewedRetry(
  directory: string,
  evidenceFile: string,
  runner: (directory: string) => CommandResult = (cwd) => {
    const result = spawnSync("npm", ["audit", "signatures", "--omit=dev"], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" },
    });
    if (result.error) throw result.error;
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  },
): void {
  const evidence: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = runner(directory);
    const output = `attempt=${attempt} status=${result.status ?? "signal"}\n${result.stdout}${result.stderr}`;
    evidence.push(output);
    fs.writeFileSync(evidenceFile, evidence.join("\n"));
    if (result.status === 0) return;
    if (!output.includes("npm error Failed to download") || attempt === 3) {
      throw new Error(
        `npm audit signatures failed after ${attempt} attempt(s): ${result.stderr || result.stdout}`,
      );
    }
    evidence.push(`retrying transient signature download after attempt ${attempt}\n`);
  }
}

function assertTreeReadOnly(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = fs.lstatSync(current);
    if ((stat.mode & 0o222) !== 0)
      throw new Error(`trusted npm cache entry remained writable: ${current}`);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(current)) pending.push(path.join(current, child));
    }
  }
}

function makeTreeOwnerWritable(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = fs.lstatSync(current);
    fs.chmodSync(current, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(current)) pending.push(path.join(current, child));
    }
  }
}

function verifyWechatInstallCacheBoundary(
  graph: LockedGraph,
  tempRoot: string,
  registryOrigin: string,
): void {
  const trustedCache = path.join(tempRoot, "wechat-trusted-cache");
  const installCache = path.join(tempRoot, "wechat-install-cache");
  const packDirectory = path.join(tempRoot, "wechat-pack");
  fs.mkdirSync(trustedCache);
  fs.mkdirSync(installCache);
  fs.mkdirSync(packDirectory);
  const env = {
    ...process.env,
    NPM_CONFIG_CACHE: trustedCache,
    NPM_CONFIG_REGISTRY: registryOrigin,
    NPM_CONFIG_USERCONFIG: "/dev/null",
  };
  const cache = spawnSync("npm", ["cache", "add", graph.packageSpec], {
    encoding: "utf-8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (cache.error) throw cache.error;
  if (cache.status !== 0) throw new Error(`npm cache add failed: ${cache.stderr || cache.stdout}`);
  fs.chmodSync(trustedCache, 0o555);
  for (const entry of fs.readdirSync(trustedCache, { recursive: true })) {
    fs.chmodSync(
      path.join(trustedCache, entry.toString()),
      fs.lstatSync(path.join(trustedCache, entry.toString())).isDirectory() ? 0o555 : 0o444,
    );
  }
  assertTreeReadOnly(trustedCache);
  fs.cpSync(trustedCache, installCache, { recursive: true, force: true });
  makeTreeOwnerWritable(installCache);
  packReviewedNpmArchive({
    env: { ...env, NPM_CONFIG_CACHE: installCache, NPM_CONFIG_OFFLINE: "true" },
    expectedIntegrity: graph.integrity,
    label: graph.label,
    packageSpec: graph.packageSpec,
    tarballUrl: graph.tarballUrl,
    tempDirectory: packDirectory,
  });
  assertTreeReadOnly(trustedCache);
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
    cacheFile: graphCacheFile(graph.id),
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
    threshold: graph.severityThreshold ?? config.severityThreshold,
    throwOnBlock: false,
  });
  if (graph.id === "openclaw-runtime") {
    normalizeOpenClawSignatureAlias(directory);
  }
  if (graph.signatureAudit === "retry-download-failures") {
    verifySignaturesWithReviewedRetry(
      directory,
      path.join(artifactDirectory, `locked-graph-${index + 1}-signatures.txt`),
    );
  } else {
    run("npm", ["audit", "signatures", "--omit=dev"], directory);
  }
  if (graph.inputValidation === "wechat-runtime") {
    verifyWechatInstallCacheBoundary(graph, tempRoot, config.registryOrigin);
  }
  return result;
}

function auditSourceGraph(
  config: AuditConfig,
  tempRoot: string,
  exceptionFile: string,
  artifactDirectory: string,
  npmVersion: string,
) {
  const sourcePackage = targetRepositoryPath("package.json", "NemoClaw CLI package manifest");
  const sourceLock = targetRepositoryPath("package-lock.json", "NemoClaw CLI lockfile");
  const sourceManifest = readJsonObject(sourcePackage, "NemoClaw CLI package manifest");
  if (typeof sourceManifest.name !== "string" || typeof sourceManifest.version !== "string") {
    throw new Error("NemoClaw CLI package manifest must declare its name and version");
  }
  const directory = materializeSourceGraph(
    sourcePackage,
    sourceLock,
    path.join(tempRoot, "source-graph"),
    config.registryOrigin,
    installProductionSourceDependencies,
    config.sourceRegistryPackage,
    config.sourceNestedShrinkwrapPackages,
    config.sourceRegistryPackagesWithoutIntegrity,
  );
  return auditMaterializedSourceGraph({
    directory,
    exceptionFile,
    artifactDirectory,
    npmVersion,
    packageSpec: `${sourceManifest.name}@${sourceManifest.version}`,
    threshold: config.severityThreshold,
  });
}

export function auditMaterializedSourceGraph(
  options: Readonly<{
    artifactDirectory: string;
    directory: string;
    exceptionFile: string;
    npmVersion: string;
    packageSpec: string;
    threshold: Severity;
  }>,
  dependencies: Readonly<{
    runAudit?: typeof runReviewedNpmAudit;
    verifySignatures?: (directory: string) => void;
  }> = {},
): AuditPolicyResult {
  const result = (dependencies.runAudit ?? runReviewedNpmAudit)({
    cacheFile: graphCacheFile(SOURCE_GRAPH.id),
    directory: options.directory,
    exceptionFile: options.exceptionFile,
    graph: SOURCE_GRAPH.id,
    provenance: {
      label: SOURCE_GRAPH.label,
      nodeVersion: process.version,
      npmVersion: options.npmVersion,
      packageSpecs: [options.packageSpec],
    },
    reportFile: path.join(options.artifactDirectory, "source-graph.json"),
    resultFile: path.join(options.artifactDirectory, "source-graph-policy.json"),
    threshold: options.threshold,
    throwOnBlock: false,
  });
  (
    dependencies.verifySignatures ??
    ((directory) => run("npm", ["audit", "signatures", "--omit=dev"], directory))
  )(options.directory);
  return result;
}

export function emitAuditReceipt(
  options: Readonly<{
    artifactDirectory: string;
    graphId: string;
    npmVersion: string;
    packageJsonFile: string;
    packageLockFile: string;
    preserveInputs?: boolean;
    rawReportFile: string;
    registryOrigin: string;
    result: AuditPolicyResult;
    threshold: Severity;
  }>,
): string {
  if (
    options.result.status === "blocked" ||
    options.result.unacceptedBlockingAdvisories.length > 0
  ) {
    throw new Error(`cannot emit receipt for blocked graph ${options.graphId}`);
  }
  const provenanceFile = options.rawReportFile.replace(/\.json$/, ".provenance.json");
  const provenance = readJsonObject(provenanceFile, `${options.graphId} audit provenance`);
  const cache = provenance.cache as Record<string, unknown> | undefined;
  const run = provenance.run as Record<string, unknown> | undefined;
  const createdAt = cache?.createdAt ?? run?.startedAt;
  if (typeof createdAt !== "string") {
    throw new Error(`${options.graphId} audit provenance lacks evidence creation time`);
  }
  const receipt = createAuditReceipt({
    acceptedAdvisoryIds: options.result.acceptedAdvisories,
    createdAt: new Date(createdAt),
    blockingAdvisoryIds: options.result.unacceptedBlockingAdvisories.map(
      ({ advisory }) => advisory,
    ),
    exceptionPolicySha256: options.result.exceptionPolicySha256,
    graphId: options.graphId,
    npmVersion: options.npmVersion,
    packageJson: fs.readFileSync(options.packageJsonFile),
    packageLock: fs.readFileSync(options.packageLockFile),
    rawResponse: fs.readFileSync(options.rawReportFile),
    registryOrigin: options.registryOrigin,
    severityThreshold: options.threshold,
  });
  const receiptFile = path.join(options.artifactDirectory, `${options.graphId}.receipt.json`);
  const transportRawFile = path.join(options.artifactDirectory, `${options.graphId}.raw.json`);
  fs.copyFileSync(options.rawReportFile, transportRawFile);
  fs.chmodSync(transportRawFile, 0o600);
  if (options.preserveInputs) {
    for (const [source, suffix] of [
      [options.packageJsonFile, "package.json"],
      [options.packageLockFile, "package-lock.json"],
    ] as const) {
      const destination = path.join(options.artifactDirectory, `${options.graphId}.${suffix}`);
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o600);
    }
  }
  fs.writeFileSync(receiptFile, canonicalAuditReceipt(receipt), { mode: 0o600 });
  return receiptFile;
}

export function assertReviewedAuditReportsPass(
  reports: readonly ReviewedAuditReport[],
  threshold: Severity,
): void {
  const failures = reports
    .filter(({ result }) => result.unacceptedBlockingAdvisories.length > 0)
    .map(
      ({ label, result, threshold: reportThreshold }) =>
        `${label}: ${result.unacceptedBlockingAdvisories.length} unaccepted at or above ${reportThreshold ?? threshold}`,
    );
  if (failures.length > 0)
    throw new Error(`reviewed npm audit threshold failed\n${failures.join("\n")}`);
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
    new Set([
      SOURCE_GRAPH.id,
      config.archiveGraphId,
      ...config.lockedGraphs.map((graph) => graph.id),
    ]),
  );
  fs.rmSync(artifactDirectory, { recursive: true, force: true });
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const npmVersion = run("npm", ["--version"], TRUSTED_REPO_ROOT).stdout.trim();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-audit-"));
  try {
    const sourceResult = auditSourceGraph(
      config,
      tempRoot,
      exceptionFile,
      artifactDirectory,
      npmVersion,
    );
    const archiveDirectory = materializeArchiveGraph(
      config.archivePackages,
      tempRoot,
      config.archiveTarVersion,
    );
    const archiveResult = runReviewedNpmAudit({
      cacheFile: graphCacheFile(config.archiveGraphId),
      directory: archiveDirectory,
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
    });
    const lockedResults = config.lockedGraphs.map((graph, index) =>
      auditLockedGraph(
        graph,
        index,
        config,
        tempRoot,
        exceptionFile,
        artifactDirectory,
        npmVersion,
      ),
    );
    const reports = [
      { label: SOURCE_GRAPH.label, result: sourceResult },
      { label: "reviewed archive graph", result: archiveResult },
      ...config.lockedGraphs.map((graph, index) => ({
        label: graph.label,
        threshold: graph.severityThreshold ?? config.severityThreshold,
        result: lockedResults[index]!,
      })),
    ];
    assertReviewedAuditReportsPass(reports, config.severityThreshold);

    emitAuditReceipt({
      artifactDirectory,
      graphId: SOURCE_GRAPH.id,
      npmVersion,
      packageJsonFile: targetRepositoryPath("package.json", "NemoClaw CLI package manifest"),
      packageLockFile: targetRepositoryPath("package-lock.json", "NemoClaw CLI lockfile"),
      rawReportFile: path.join(artifactDirectory, "source-graph.json"),
      registryOrigin: config.registryOrigin,
      result: sourceResult,
      threshold: config.severityThreshold,
    });
    emitAuditReceipt({
      artifactDirectory,
      graphId: config.archiveGraphId,
      npmVersion,
      packageJsonFile: path.join(archiveDirectory, "package.json"),
      packageLockFile: path.join(archiveDirectory, "package-lock.json"),
      preserveInputs: true,
      rawReportFile: path.join(artifactDirectory, "reviewed-archive-graph.json"),
      registryOrigin: config.registryOrigin,
      result: archiveResult,
      threshold: config.severityThreshold,
    });
    config.lockedGraphs.forEach((graph, index) => {
      emitAuditReceipt({
        artifactDirectory,
        graphId: graph.id,
        npmVersion,
        packageJsonFile: targetRepositoryPath(
          path.join(graph.directory, "package.json"),
          `${graph.label} package manifest`,
        ),
        packageLockFile: targetRepositoryPath(
          path.join(graph.directory, "package-lock.json"),
          `${graph.label} lockfile`,
        ),
        rawReportFile: path.join(artifactDirectory, `locked-graph-${index + 1}.json`),
        registryOrigin: config.registryOrigin,
        result: lockedResults[index]!,
        threshold: graph.severityThreshold ?? config.severityThreshold,
      });
    });
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
