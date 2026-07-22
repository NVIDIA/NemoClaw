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

type GraphAuditContext = Readonly<{
  label: string;
  nodeVersion: string;
  npmVersion: string;
  packageSpecs: readonly string[];
}>;

// Exported for the provenance-ordering regression test; production callers
// stay inside this script's main().
export function auditGraph(
  directory: string,
  reportPath: string,
  context: GraphAuditContext,
): Record<string, unknown> {
  const startedAt = new Date().toISOString();
  const result = run("npm", ["audit", "--omit=dev", "--json"], directory, true);
  const finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, result.stdout);
  // Registry introspection is best-effort provenance and must never mask the
  // audit outcome established below.
  let registry = "";
  try {
    registry = run("npm", ["config", "get", "registry"], directory).stdout.trim();
  } catch {
    registry = "";
  }
  // The sidecar is written even when the audit failed: a failed attempt is
  // exactly the run whose provenance matters when reconstructing detection
  // timelines, matching the records-the-attempt semantics of
  // .github/actions/ci-wechat-runtime-audit/audit.sh.
  let report: Record<string, unknown> = {};
  let auditFailure: Error | undefined;
  try {
    report = parseAuditReport(result);
  } catch (error) {
    auditFailure = error instanceof Error ? error : new Error(String(error));
  }
  const provenance = buildAuditProvenance({
    failure: auditFailure?.message,
    finishedAt,
    label: context.label,
    nodeVersion: context.nodeVersion,
    npmVersion: context.npmVersion,
    packageSpecs: context.packageSpecs,
    // Convention shared with the WeChat audit sidecar: rawReportPath is
    // relative to the directory containing the sidecar.
    rawReportPath: path.basename(reportPath),
    registry,
    report,
    startedAt,
  });
  fs.writeFileSync(provenanceSidecarPath(reportPath), `${JSON.stringify(provenance, null, 2)}\n`);
  if (auditFailure) throw auditFailure;
  return report;
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

export type AuditEndpoints = Readonly<{
  configuredRegistry: string | null;
  bulkAdvisoryEndpoint: string | null;
  note: string;
}>;

// npm (>= 7) derives its audit endpoint from the configured registry the same
// way (see npm/cli arborist audit-report): it posts the dependency graph to
// the bulk advisory endpoint only — there is no quick-audit fallback; on
// request failure npm reports no advisory data. Recording the endpoint plus
// the configured registry pins down which advisory database actually served a
// given report (#7338).
//
// Keep in sync with the inline provenance writer in
// .github/actions/ci-wechat-runtime-audit/audit.sh, which duplicates this
// derivation for the shell-only WeChat audit.
export function deriveAuditEndpoints(configuredRegistry: string): AuditEndpoints {
  if (configuredRegistry.trim() === "") {
    // An endpoint derived from an unknown registry would be a nonsense claim;
    // record the unknown explicitly instead.
    return {
      configuredRegistry: null,
      bulkAdvisoryEndpoint: null,
      note: "the configured registry could not be determined for this run, so the audit endpoint is unknown.",
    };
  }
  const base = configuredRegistry.replace(/\/+$/, "");
  return {
    configuredRegistry,
    bulkAdvisoryEndpoint: `${base}/-/npm/v1/security/advisories/bulk`,
    note: "npm audit posts the dependency graph to the bulk advisory endpoint of the configured registry; on request failure npm reports no advisory data.",
  };
}

const GHSA_ID_IN_URL = /GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/gi;

// Keep in sync with the inline provenance writer in
// .github/actions/ci-wechat-runtime-audit/audit.sh, which duplicates this
// extraction for the shell-only WeChat audit.
export function extractAdvisoryIds(report: Record<string, unknown>): readonly string[] {
  const ids = new Set<string>();
  const vulnerabilities = report.vulnerabilities;
  const findings =
    typeof vulnerabilities === "object" &&
    vulnerabilities !== null &&
    !Array.isArray(vulnerabilities)
      ? Object.values(vulnerabilities)
      : [];
  for (const finding of findings) {
    const via = (finding as Record<string, unknown> | null)?.via;
    if (!Array.isArray(via)) continue;
    for (const cause of via) {
      if (typeof cause !== "object" || cause === null) continue;
      const url = (cause as Record<string, unknown>).url;
      if (typeof url !== "string") continue;
      for (const match of url.match(GHSA_ID_IN_URL) ?? []) {
        ids.add(`GHSA${match.slice(4).toLowerCase()}`);
      }
    }
  }
  return [...ids].sort();
}

export type AuditProvenance = Readonly<{
  schemaVersion: 1;
  scanner: Readonly<{ name: "npm audit"; npmVersion: string; nodeVersion: string }>;
  registry: AuditEndpoints;
  run: Readonly<{ startedAt: string; finishedAt: string }>;
  graph: Readonly<{ label: string; packageSpecs: readonly string[] }>;
  rawReportPath: string;
  advisoryIds: readonly string[];
  // Present when the audit attempt failed; the sidecar still records the run.
  failure?: string;
}>;

export function buildAuditProvenance(
  input: Readonly<{
    failure?: string;
    finishedAt: string;
    label: string;
    nodeVersion: string;
    npmVersion: string;
    packageSpecs: readonly string[];
    rawReportPath: string;
    registry: string;
    report: Record<string, unknown>;
    startedAt: string;
  }>,
): AuditProvenance {
  return {
    schemaVersion: 1,
    scanner: { name: "npm audit", npmVersion: input.npmVersion, nodeVersion: input.nodeVersion },
    registry: deriveAuditEndpoints(input.registry),
    run: { startedAt: input.startedAt, finishedAt: input.finishedAt },
    graph: { label: input.label, packageSpecs: input.packageSpecs },
    rawReportPath: input.rawReportPath,
    advisoryIds: extractAdvisoryIds(input.report),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
  };
}

export function provenanceSidecarPath(reportPath: string): string {
  return `${reportPath.replace(/\.json$/, "")}.provenance.json`;
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
    return remediateReviewedOpenClawArchive({
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
  const npmVersion = run("npm", ["--version"], REPO_ROOT).stdout.trim();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-audit-"));
  try {
    const reports = [
      {
        label: "reviewed archive graph",
        report: auditGraph(
          materializeArchiveGraph(config.archivePackages, tempRoot),
          path.join(artifactDirectory, "reviewed-archive-graph.json"),
          {
            label: "reviewed archive graph",
            nodeVersion: process.version,
            npmVersion,
            packageSpecs: config.archivePackages.map((reviewed) => reviewed.packageSpec),
          },
        ),
      },
      ...config.lockedGraphs.map((graph, index) => ({
        label: graph.label,
        report: auditGraph(
          materializeLockedGraph(graph, tempRoot),
          path.join(artifactDirectory, `locked-graph-${index + 1}.json`),
          {
            label: graph.label,
            nodeVersion: process.version,
            npmVersion,
            packageSpecs: [graph.packageSpec],
          },
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
