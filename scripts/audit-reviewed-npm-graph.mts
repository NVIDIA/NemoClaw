#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { remediateReviewedOpenClawArchive } from "./lib/openclaw-npm-remediation.mts";
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
type ArchiveReview = Readonly<{
  contract: string;
  expectedFindings: readonly ReviewedFinding[];
  graphLabel: string;
}>;
type AuditConfig = Readonly<{
  archiveReview: ArchiveReview;
  archivePackages: readonly ReviewedPackage[];
  artifactDirectory: string;
  lockedGraphs: readonly LockedGraph[];
  nodeVersion: string;
  schemaVersion: 1;
  severityThreshold: Severity;
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
    parsed.schemaVersion !== 1 ||
    !SEVERITIES.includes(parsed.severityThreshold) ||
    !Array.isArray(parsed.archivePackages) ||
    !Array.isArray(parsed.lockedGraphs) ||
    parsed.archiveReview?.contract !==
      "exact vulnerable input; any high/critical finding drift fails; remediated output is threshold-gated" ||
    typeof parsed.archiveReview?.graphLabel !== "string" ||
    !Array.isArray(parsed.archiveReview.expectedFindings)
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
): ReviewedFinding[] {
  if (threshold !== "high" && threshold !== "critical") {
    throw new Error(`reviewed raw npm audit threshold must be high or critical, got ${threshold}`);
  }
  const vulnerabilities = object(report.vulnerabilities, "npm audit vulnerabilities");
  const findings: ReviewedFinding[] = [];
  for (const [key, value] of Object.entries(vulnerabilities)) {
    const vulnerability = object(value, `npm audit vulnerability ${key}`);
    const findingSeverity = severity(vulnerability.severity, `npm audit vulnerability ${key}`);
    if (!atOrAbove(findingSeverity, threshold)) continue;
    if (findingSeverity !== "high" && findingSeverity !== "critical") {
      throw new Error(`reviewed raw npm audit found unsupported severity ${findingSeverity}`);
    }
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
      .map((entry, index) => ({
        id: advisoryId(entry.url, `npm audit vulnerability ${key} via ${index}`),
        severity: severity(entry.severity, `npm audit vulnerability ${key} via ${index}`),
      }))
      .filter(
        (entry): entry is ReviewedAdvisory =>
          entry.severity === "high" || entry.severity === "critical",
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    findings.push({
      advisories,
      nodes: sortedUniqueStrings(vulnerability.nodes, `npm audit vulnerability ${key} nodes`),
      packageName: key,
      severity: findingSeverity,
    });
  }
  return findings.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function normalizeReviewedFindings(findings: readonly ReviewedFinding[]): ReviewedFinding[] {
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
): void {
  // The reviewed raw graph is an exact high-and-critical allowlist. Keep this
  // independent from the configurable threshold used for remediated graphs so
  // raising that threshold cannot silently stop detecting new high findings.
  const actual = highSeverityAuditFindings(report, "high");
  const normalizedExpected = normalizeReviewedFindings(expected);
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(
      `reviewed raw npm audit findings changed\nExpected: ${JSON.stringify(normalizedExpected)}\nActual:   ${JSON.stringify(actual)}`,
    );
  }
}

function installArchiveGraph(
  graphName: string,
  archivePaths: readonly string[],
  tempRoot: string,
): string {
  const graphDirectory = path.join(tempRoot, graphName);
  fs.mkdirSync(graphDirectory);
  fs.writeFileSync(
    path.join(graphDirectory, "package.json"),
    `${JSON.stringify({ name: "nemoclaw-reviewed-production-graph", private: true, version: "1.0.0" }, null, 2)}\n`,
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", ...archivePaths],
    graphDirectory,
  );
  return graphDirectory;
}

function materializeArchiveGraphs(
  packages: readonly ReviewedPackage[],
  tempRoot: string,
): Readonly<{ raw: string; remediated: string }> {
  const archives = packages.map((reviewed) => ({
    packageSpec: reviewed.packageSpec,
    packed: packReviewedNpmArchive({
      expectedIntegrity: reviewed.integrity,
      label: reviewed.label,
      packageSpec: reviewed.packageSpec,
      tarballUrl: reviewed.tarballUrl,
      tempDirectory: tempRoot,
    }),
  }));
  const raw = installArchiveGraph(
    "reviewed-raw-archive-graph",
    archives.map(({ packed }) => packed.archivePath),
    tempRoot,
  );
  const remediatedPaths = archives.map(({ packageSpec, packed }) =>
    remediateReviewedOpenClawArchive({
      archivePath: packed.archivePath,
      packageSpec,
      workingDirectory: packed.rootDirectory,
    }),
  );
  const remediated = installArchiveGraph(
    "reviewed-remediated-archive-graph",
    remediatedPaths.map((archive) => archive.archivePath),
    tempRoot,
  );
  return { raw, remediated };
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
    const archiveGraphs = materializeArchiveGraphs(config.archivePackages, tempRoot);
    const rawArchiveReport = auditGraph(
      archiveGraphs.raw,
      path.join(artifactDirectory, "reviewed-raw-archive-graph.json"),
    );
    assertReviewedAuditFindings(
      rawArchiveReport,
      config.archiveReview.expectedFindings,
    );
    const rawArchiveCounts = vulnerabilityCounts(rawArchiveReport);
    console.log(
      `${config.archiveReview.graphLabel} exact reviewed input: ${SEVERITIES.map((entry) => `${entry}=${rawArchiveCounts[entry]}`).join(" ")}`,
    );
    const reports = [
      {
        label: "reviewed remediated archive graph",
        report: auditGraph(
          archiveGraphs.remediated,
          path.join(artifactDirectory, "reviewed-remediated-archive-graph.json"),
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
