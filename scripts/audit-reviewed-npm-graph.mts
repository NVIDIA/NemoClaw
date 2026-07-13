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
type AuditConfig = Readonly<{
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
    !Array.isArray(parsed.lockedGraphs)
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
    const reports = [
      {
        label: "reviewed archive graph",
        report: auditGraph(
          materializeArchiveGraph(config.archivePackages, tempRoot),
          path.join(artifactDirectory, "reviewed-archive-graph.json"),
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
