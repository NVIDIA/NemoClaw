#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packReviewedNpmArchive, verifyReviewedNpmMetadata } from "./lib/reviewed-npm-archive.mts";

type Severity = "info" | "low" | "moderate" | "high" | "critical";
type ReviewedPackage = Readonly<{
  integrity: string;
  label: string;
  packageSpec: string;
  tarballUrl: string;
}>;
type LockedGraph = ReviewedPackage & Readonly<{ directory: string }>;
type ReviewedAdvisory = Readonly<{
  id: string;
  severity: "high" | "critical";
}>;
type ReviewedFinding = Readonly<{
  advisories: readonly ReviewedAdvisory[];
  nodes: readonly string[];
  packageName: string;
  severity: "high" | "critical";
}>;
type RemediatedNode = Readonly<{
  node: string;
  vulnerableVersion: string;
}>;
type RemediatedPackage = Readonly<{
  integrity: string;
  name: string;
  nodes: readonly RemediatedNode[];
  tarballUrl: string;
  version: string;
}>;
type HistoricalReview = Readonly<{
  expectedFindings: readonly ReviewedFinding[];
  graphLabel: string;
  remediatedPackages: readonly RemediatedPackage[];
}>;
type AuditConfig = Readonly<{
  archivePackages: readonly ReviewedPackage[];
  artifactDirectory: string;
  historicalReview: HistoricalReview;
  lockedGraphs: readonly LockedGraph[];
  nodeVersion: string;
  schemaVersion: 2;
  severityThreshold: "high";
}>;

export type AuditFinding = Readonly<{
  advisories: readonly ReviewedAdvisory[];
  nodes: readonly string[];
  packageName: string;
  severity: "high" | "critical";
}>;

export type PackageInventory = Readonly<{
  node: string;
  packageName: string;
  version: string;
}>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json");
const SEVERITIES: readonly Severity[] = ["info", "low", "moderate", "high", "critical"];

function run(command: string, args: readonly string[], cwd: string, allowAuditFindings = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowAuditFindings) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function readConfig(): AuditConfig {
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as AuditConfig;
  if (
    parsed.schemaVersion !== 2 ||
    parsed.severityThreshold !== "high" ||
    !Array.isArray(parsed.archivePackages) ||
    !Array.isArray(parsed.lockedGraphs) ||
    typeof parsed.historicalReview?.graphLabel !== "string" ||
    !Array.isArray(parsed.historicalReview.expectedFindings) ||
    !Array.isArray(parsed.historicalReview.remediatedPackages)
  ) {
    throw new Error("ci/reviewed-npm-audit.json is invalid");
  }
  return parsed;
}

function auditGraph(directory: string, reportPath: string): Record<string, unknown> {
  const result = run("npm", ["audit", "--omit=dev", "--json"], directory, true);
  fs.writeFileSync(reportPath, result.stdout);
  return parseAuditReport(result);
}

export function parseAuditReport(result: {
  status: number | null;
  stderr: string;
  stdout: string;
}): Record<string, unknown> {
  if (!result.stdout.trim()) {
    throw new Error(`npm audit did not produce JSON: ${result.stderr}`);
  }
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`npm audit returned invalid JSON: ${String(error)}`);
  }
  let counts: Record<Severity, number>;
  try {
    counts = vulnerabilityCounts(report);
  } catch (error) {
    const detail = report.error === undefined ? result.stderr : JSON.stringify(report.error);
    throw new Error(
      `npm audit failed without a complete vulnerability report: ${error instanceof Error ? error.message : String(error)}${detail ? `; ${detail}` : ""}`,
    );
  }
  const findingCount = SEVERITIES.reduce((total, severity) => total + counts[severity], 0);
  if (
    report.error !== undefined ||
    result.status === null ||
    result.status > 1 ||
    (result.status !== 0 && findingCount === 0)
  ) {
    const detail = report.error === undefined ? result.stderr : JSON.stringify(report.error);
    throw new Error(
      `npm audit failed without vulnerability findings${detail ? `: ${detail}` : ""}`,
    );
  }
  return report;
}

export function vulnerabilityCounts(report: Record<string, unknown>): Record<Severity, number> {
  const metadata = report.metadata as Record<string, unknown> | undefined;
  const vulnerabilities = metadata?.vulnerabilities as Record<string, unknown> | undefined;
  if (!vulnerabilities || Array.isArray(vulnerabilities)) {
    throw new Error("npm audit report is missing metadata.vulnerabilities");
  }
  const entries = SEVERITIES.map((severity) => {
    const value = vulnerabilities[severity];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`npm audit report has invalid ${severity} vulnerability count`);
    }
    return [severity, value] as const;
  });
  return Object.fromEntries(entries) as Record<Severity, number>;
}

export function exceedsAuditThreshold(
  counts: Readonly<Record<Severity, number>>,
  threshold: Severity,
): number {
  return SEVERITIES.slice(SEVERITIES.indexOf(threshold)).reduce(
    (total, severity) => total + counts[severity],
    0,
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function severity(value: unknown, label: string): Severity {
  if (typeof value !== "string" || !SEVERITIES.includes(value as Severity)) {
    throw new Error(`${label} has an invalid severity`);
  }
  return value as Severity;
}

function atOrAbove(candidate: Severity, threshold: Severity): boolean {
  return SEVERITIES.indexOf(candidate) >= SEVERITIES.indexOf(threshold);
}

function sortedUniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} contains duplicates`);
  return sorted;
}

function advisoryId(url: unknown, label: string): string {
  if (typeof url !== "string") throw new Error(`${label} is missing its advisory URL`);
  const match = /^https:\/\/github\.com\/advisories\/(GHSA-[0-9a-z-]+)$/u.exec(url);
  if (!match) throw new Error(`${label} has an unreviewable advisory URL: ${url}`);
  return match[1];
}

export function highSeverityAuditFindings(
  report: Record<string, unknown>,
  threshold: Severity,
): AuditFinding[] {
  const vulnerabilities = object(report.vulnerabilities, "npm audit vulnerabilities");
  const findings: AuditFinding[] = [];
  for (const [key, value] of Object.entries(vulnerabilities)) {
    const vulnerability = object(value, `npm audit vulnerability ${key}`);
    const findingSeverity = severity(vulnerability.severity, `npm audit vulnerability ${key}`);
    if (!atOrAbove(findingSeverity, threshold)) continue;
    if (vulnerability.name !== key) {
      throw new Error(`npm audit vulnerability key/name mismatch for ${key}`);
    }
    if (!Array.isArray(vulnerability.via)) {
      throw new Error(`npm audit vulnerability ${key} is missing via records`);
    }
    const advisories = vulnerability.via
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
      )
      .map((entry, index) => {
        const directSeverity = severity(
          entry.severity,
          `npm audit vulnerability ${key} via ${index}`,
        );
        return {
          id: advisoryId(entry.url, `npm audit vulnerability ${key} via ${index}`),
          severity: directSeverity,
        };
      })
      .filter(
        (entry): entry is ReviewedAdvisory =>
          entry.severity === "high" || entry.severity === "critical",
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    findings.push({
      advisories,
      nodes: sortedUniqueStrings(vulnerability.nodes, `npm audit vulnerability ${key} nodes`),
      packageName: key,
      severity: findingSeverity as "high" | "critical",
    });
  }
  return findings.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function normalizeReviewedFindings(findings: readonly ReviewedFinding[]): AuditFinding[] {
  return findings
    .map((finding) => ({
      advisories: [...finding.advisories].sort((left, right) => left.id.localeCompare(right.id)),
      nodes: [...finding.nodes].sort(),
      packageName: finding.packageName,
      severity: finding.severity,
    }))
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
}

export function assertReviewedAuditFindings(
  report: Record<string, unknown>,
  expected: readonly ReviewedFinding[],
  threshold: Severity,
): void {
  const actual = highSeverityAuditFindings(report, threshold);
  const normalizedExpected = normalizeReviewedFindings(expected);
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(
      `reviewed raw npm audit findings changed\nExpected: ${JSON.stringify(normalizedExpected)}\nActual:   ${JSON.stringify(actual)}`,
    );
  }
}

function lockPackages(lock: Record<string, unknown>): Record<string, unknown> {
  if (lock.lockfileVersion !== 3) throw new Error("reviewed npm graph must use lockfileVersion 3");
  return object(lock.packages, "reviewed npm graph packages");
}

function isPackageNode(node: string, packageName: string): boolean {
  return node === `node_modules/${packageName}` || node.endsWith(`/node_modules/${packageName}`);
}

export function packageInventory(
  lock: Record<string, unknown>,
  packageNames: readonly string[],
): PackageInventory[] {
  const names = new Set(packageNames);
  const inventory: PackageInventory[] = [];
  for (const [node, value] of Object.entries(lockPackages(lock))) {
    const packageName = packageNames.find((candidate) => isPackageNode(node, candidate));
    if (!packageName || !names.has(packageName)) continue;
    const entry = object(value, `reviewed npm graph package ${node}`);
    if (typeof entry.version !== "string") {
      throw new Error(`reviewed npm graph package ${node} is missing its version`);
    }
    inventory.push({ node, packageName, version: entry.version });
  }
  return inventory.sort((left, right) => left.node.localeCompare(right.node));
}

export function installedPackageInventory(
  directory: string,
  packageNames: readonly string[],
): PackageInventory[] {
  const reviewedNames = new Set(packageNames);
  const inventory: PackageInventory[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (path.basename(current) === "node_modules" && reviewedNames.has(entry.name)) {
        const manifest = object(
          JSON.parse(fs.readFileSync(path.join(child, "package.json"), "utf8")),
          `installed package ${child}`,
        );
        if (manifest.name !== entry.name || typeof manifest.version !== "string") {
          throw new Error(`installed package identity changed at ${child}`);
        }
        inventory.push({
          node: path.relative(directory, child).split(path.sep).join("/"),
          packageName: entry.name,
          version: manifest.version,
        });
      }
      visit(child);
    }
  };
  visit(path.join(directory, "node_modules"));
  return inventory.sort((left, right) => left.node.localeCompare(right.node));
}

function expectedInventory(
  packages: readonly RemediatedPackage[],
  version: "vulnerable" | "remediated",
): PackageInventory[] {
  return packages
    .flatMap((reviewed) =>
      reviewed.nodes.map((entry) => ({
        node: entry.node,
        packageName: reviewed.name,
        version: version === "vulnerable" ? entry.vulnerableVersion : reviewed.version,
      })),
    )
    .sort((left, right) => left.node.localeCompare(right.node));
}

export function remediateReviewedLock(
  sourceLock: Record<string, unknown>,
  remediations: readonly RemediatedPackage[],
): { inventory: PackageInventory[]; lock: Record<string, unknown> } {
  const packageNames = remediations.map((entry) => entry.name);
  const rawInventory = packageInventory(sourceLock, packageNames);
  const expectedRawInventory = expectedInventory(remediations, "vulnerable");
  if (JSON.stringify(rawInventory) !== JSON.stringify(expectedRawInventory)) {
    throw new Error(
      `reviewed raw npm package inventory changed\nExpected: ${JSON.stringify(expectedRawInventory)}\nActual:   ${JSON.stringify(rawInventory)}`,
    );
  }

  const lock = structuredClone(sourceLock);
  const packages = lockPackages(lock);
  for (const remediation of remediations) {
    for (const expectedNode of remediation.nodes) {
      const entry = object(
        packages[expectedNode.node],
        `reviewed npm graph package ${expectedNode.node}`,
      );
      entry.version = remediation.version;
      entry.resolved = remediation.tarballUrl;
      entry.integrity = remediation.integrity;
    }
  }
  const inventory = packageInventory(lock, packageNames);
  const expectedFinalInventory = expectedInventory(remediations, "remediated");
  if (JSON.stringify(inventory) !== JSON.stringify(expectedFinalInventory)) {
    throw new Error(
      `remediated npm package inventory is inconsistent\nExpected: ${JSON.stringify(expectedFinalInventory)}\nActual:   ${JSON.stringify(inventory)}`,
    );
  }
  return { inventory, lock };
}

function materializeArchiveGraph(packages: readonly ReviewedPackage[], tempRoot: string): string {
  const graphDirectory = path.join(tempRoot, "reviewed-archive-graph");
  fs.mkdirSync(graphDirectory);
  fs.writeFileSync(
    path.join(graphDirectory, "package.json"),
    `${JSON.stringify({ name: "nemoclaw-reviewed-production-graph", private: true, version: "1.0.0" }, null, 2)}\n`,
  );
  const archives = packages.map((reviewed) =>
    packReviewedNpmArchive({
      expectedIntegrity: reviewed.integrity,
      label: reviewed.label,
      packageSpec: reviewed.packageSpec,
      tarballUrl: reviewed.tarballUrl,
      tempDirectory: tempRoot,
    }),
  );
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

function materializeLockedGraph(graph: LockedGraph, tempRoot: string): string {
  verifyReviewedNpmMetadata({
    expectedIntegrity: graph.integrity,
    label: graph.label,
    packageSpec: graph.packageSpec,
    tarballUrl: graph.tarballUrl,
  });
  const source = path.join(REPO_ROOT, graph.directory);
  const destination = path.join(tempRoot, `locked-${path.basename(graph.directory)}`);
  fs.mkdirSync(destination);
  for (const filename of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(source, filename), path.join(destination, filename));
  }
  run("npm", ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], destination);
  return destination;
}

function materializeRemediatedInstalledGraph(
  sourceDirectory: string,
  historicalReview: HistoricalReview,
  tempRoot: string,
  artifactDirectory: string,
): string {
  const sourceLock = JSON.parse(
    fs.readFileSync(path.join(sourceDirectory, "package-lock.json"), "utf8"),
  ) as Record<string, unknown>;
  const remediated = remediateReviewedLock(sourceLock, historicalReview.remediatedPackages);
  const destination = path.join(tempRoot, "reviewed-remediated-installed-graph");
  fs.mkdirSync(destination);

  const reviewedArchives = new Map(
    historicalReview.remediatedPackages.map((reviewed) => [
      reviewed.name,
      packReviewedNpmArchive({
        expectedIntegrity: reviewed.integrity,
        label: `remediated npm proof ${reviewed.name}@${reviewed.version}`,
        packageSpec: `${reviewed.name}@${reviewed.version}`,
        tarballUrl: reviewed.tarballUrl,
        tempDirectory: tempRoot,
      }).archivePath,
    ]),
  );
  const directDependencies: Record<string, string> = {};
  const parentDependencies = new Map<string, Record<string, string>>();
  let nodeArchiveIndex = 0;
  for (const reviewed of historicalReview.remediatedPackages) {
    const reviewedArchivePath = reviewedArchives.get(reviewed.name) as string;
    for (const expectedNode of reviewed.nodes) {
      nodeArchiveIndex += 1;
      const archivePath = path.join(tempRoot, `reviewed-remediation-node-${nodeArchiveIndex}.tgz`);
      fs.copyFileSync(reviewedArchivePath, archivePath);
      const directNode = `node_modules/${reviewed.name}`;
      if (expectedNode.node === directNode) {
        directDependencies[reviewed.name] = `file:${archivePath}`;
        continue;
      }
      const suffix = `/node_modules/${reviewed.name}`;
      if (!expectedNode.node.startsWith("node_modules/") || !expectedNode.node.endsWith(suffix)) {
        throw new Error(
          `reviewed remediation node has an unsupported layout: ${expectedNode.node}`,
        );
      }
      const parentName = expectedNode.node.slice("node_modules/".length, -suffix.length);
      if (!/^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)$/u.test(parentName)) {
        throw new Error(`reviewed remediation parent is invalid: ${parentName}`);
      }
      const dependencies = parentDependencies.get(parentName) ?? {};
      dependencies[reviewed.name] = `file:${archivePath}`;
      parentDependencies.set(parentName, dependencies);
    }
  }

  const parentArchiveDirectory = path.join(tempRoot, "reviewed-remediation-parent-archives");
  fs.mkdirSync(parentArchiveDirectory);
  for (const [index, [parentName, dependencies]] of [...parentDependencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .entries()) {
    const parentDirectory = path.join(tempRoot, `reviewed-remediation-parent-${index + 1}`);
    fs.mkdirSync(parentDirectory);
    fs.writeFileSync(
      path.join(parentDirectory, "package.json"),
      `${JSON.stringify(
        {
          dependencies,
          name: parentName,
          version: "0.0.0-reviewed-remediation-proof",
        },
        null,
        2,
      )}\n`,
    );
    const packed = run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", parentArchiveDirectory],
      parentDirectory,
    );
    const packResult = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>;
    const filename = packResult[0]?.filename;
    if (
      packResult.length !== 1 ||
      typeof filename !== "string" ||
      path.basename(filename) !== filename
    ) {
      throw new Error(`npm pack returned an invalid synthetic parent result for ${parentName}`);
    }
    directDependencies[parentName] = `file:${path.join(parentArchiveDirectory, filename)}`;
  }

  fs.writeFileSync(
    path.join(destination, "package.json"),
    `${JSON.stringify(
      {
        dependencies: Object.fromEntries(
          Object.entries(directDependencies).sort(([left], [right]) => left.localeCompare(right)),
        ),
        name: "nemoclaw-reviewed-remediated-installed-graph",
        private: true,
        version: "1.0.0",
      },
      null,
      2,
    )}\n`,
  );
  run(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--install-strategy=nested",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ],
    destination,
  );
  const generatedLockPath = path.join(destination, "package-lock.json");
  const generatedLock = JSON.parse(fs.readFileSync(generatedLockPath, "utf8")) as Record<
    string,
    unknown
  >;
  const generatedPackages = lockPackages(generatedLock);
  const generatedInventory = packageInventory(
    generatedLock,
    historicalReview.remediatedPackages.map((entry) => entry.name),
  );
  for (const expected of remediated.inventory) {
    if (generatedPackages[expected.node] !== undefined) continue;
    const source = generatedInventory.find(
      (entry) => entry.packageName === expected.packageName && entry.version === expected.version,
    );
    if (!source) {
      throw new Error(`npm did not resolve ${expected.packageName}@${expected.version}`);
    }
    generatedPackages[expected.node] = structuredClone(
      object(generatedPackages[source.node], `generated npm package ${source.node}`),
    );
  }
  fs.writeFileSync(generatedLockPath, `${JSON.stringify(generatedLock, null, 2)}\n`);
  run(
    "npm",
    [
      "ci",
      "--install-strategy=nested",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ],
    destination,
  );
  const installedInventory = installedPackageInventory(
    destination,
    historicalReview.remediatedPackages.map((entry) => entry.name),
  );
  if (JSON.stringify(installedInventory) !== JSON.stringify(remediated.inventory)) {
    throw new Error(
      `installed remediated npm package inventory is inconsistent\nExpected: ${JSON.stringify(remediated.inventory)}\nActual:   ${JSON.stringify(installedInventory)}`,
    );
  }
  fs.writeFileSync(
    path.join(artifactDirectory, "reviewed-archive-graph-remediated-inventory.json"),
    `${JSON.stringify(
      {
        graph: historicalReview.graphLabel,
        packages: installedInventory,
        schemaVersion: 1,
      },
      null,
      2,
    )}\n`,
  );
  return destination;
}

function main(): void {
  const config = readConfig();
  const expectedNode = `v${config.nodeVersion}`;
  if (process.version !== expectedNode) {
    throw new Error(`reviewed npm audit requires Node ${expectedNode}; running ${process.version}`);
  }
  const artifactDirectory = path.join(REPO_ROOT, config.artifactDirectory);
  fs.rmSync(artifactDirectory, { recursive: true, force: true });
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-audit-"));
  try {
    const archiveGraph = materializeArchiveGraph(config.archivePackages, tempRoot);
    const rawArchiveReport = auditGraph(
      archiveGraph,
      path.join(artifactDirectory, "reviewed-archive-graph.json"),
    );
    assertReviewedAuditFindings(
      rawArchiveReport,
      config.historicalReview.expectedFindings,
      config.severityThreshold,
    );
    const remediatedGraph = materializeRemediatedInstalledGraph(
      archiveGraph,
      config.historicalReview,
      tempRoot,
      artifactDirectory,
    );
    const reports = [
      {
        label: `${config.historicalReview.graphLabel} remediated installed proof`,
        report: auditGraph(
          remediatedGraph,
          path.join(artifactDirectory, "reviewed-archive-graph-remediated.json"),
        ),
      },
      ...config.lockedGraphs.map((graph, index) => ({
        label: graph.label,
        report: auditGraph(
          materializeLockedGraph(graph, tempRoot),
          path.join(artifactDirectory, `locked-graph-${index + 1}.json`),
        ),
      })),
    ];
    const rawCounts = vulnerabilityCounts(rawArchiveReport);
    console.log(
      `${config.historicalReview.graphLabel} raw reviewed input: ${SEVERITIES.map((entry) => `${entry}=${rawCounts[entry]}`).join(" ")}`,
    );
    const failures: string[] = [];
    for (const { label, report } of reports) {
      const counts = vulnerabilityCounts(report);
      const summary = SEVERITIES.map((severity) => `${severity}=${counts[severity]}`).join(" ");
      console.log(`${label}: ${summary}`);
      const blocked = exceedsAuditThreshold(counts, config.severityThreshold);
      if (blocked > 0)
        failures.push(`${label}: ${blocked} at or above ${config.severityThreshold}`);
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
