#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type AuditException = Readonly<{
  advisory: string;
  decision: "not-affected" | "temporary-risk-acceptance";
  expires: string;
  graph: string;
  installedVersion: string;
  owner: string;
  package: string;
  rationale: string;
  severity: Severity;
  trackingIssue: string;
  compensatingControls?: readonly string[];
}>;

export type AuditExceptionRegistry = Readonly<{
  exceptions: readonly AuditException[];
  schemaVersion: 1;
}>;

type DirectFinding = Readonly<{
  advisory: string;
  installedVersion: string;
  package: string;
  severity: Severity;
}>;

export type AuditPolicyResult = Readonly<{
  acceptedAdvisories: readonly string[];
  blockingThreshold: Severity;
  exceptionPolicySha256: string;
  graph: string;
  reported: Readonly<Record<Severity, number>>;
  schemaVersion: 1;
  status: "clean" | "accepted-exceptions" | "blocked";
  unacceptedBlockingAdvisories: readonly DirectFinding[];
}>;

export type AuditEndpoints = Readonly<{
  configuredRegistry: string | null;
  bulkAdvisoryEndpoint: string | null;
  note: string;
}>;

export type AuditProvenance = Readonly<{
  schemaVersion: 1;
  scanner: Readonly<{ name: "npm audit"; npmVersion: string; nodeVersion: string }>;
  registry: AuditEndpoints;
  run: Readonly<{ startedAt: string; finishedAt: string }>;
  graph: Readonly<{ label: string; packageSpecs: readonly string[] }>;
  rawReportPath: string;
  advisoryIds: readonly string[];
  failure?: string;
}>;

export type AuditProvenanceContext = Readonly<{
  label: string;
  nodeVersion: string;
  npmVersion: string;
  packageSpecs: readonly string[];
}>;

const EXCEPTION_KEYS = new Set([
  "advisory",
  "compensatingControls",
  "decision",
  "expires",
  "graph",
  "installedVersion",
  "owner",
  "package",
  "rationale",
  "severity",
  "trackingIssue",
]);
const NEMOCLAW_TRACKING_URL = /^https:\/\/github\.com\/NVIDIA\/NemoClaw\/(?:issues|pull)\/\d+$/u;
const ADVISORY_ID = /^(?:GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|CVE-\d{4}-\d+|NPM-\d+)$/u;
const GRAPH_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_EXCEPTION_LIFETIME_DAYS = 30;
const GHSA_ID_IN_URL = /GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/gi;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a string`);
  return value;
}

function parseException(value: unknown, index: number, now: Date): AuditException {
  const label = `npm audit exception ${index + 1}`;
  const parsed = asRecord(value, label);
  requireExactKeys(parsed, EXCEPTION_KEYS, label);

  const advisory = nonEmptyString(parsed.advisory, `${label}.advisory`);
  if (!ADVISORY_ID.test(advisory)) throw new Error(`${label}.advisory is invalid`);
  const graph = nonEmptyString(parsed.graph, `${label}.graph`);
  if (!GRAPH_ID.test(graph)) throw new Error(`${label}.graph is invalid`);
  const severity = nonEmptyString(parsed.severity, `${label}.severity`);
  if (!SEVERITIES.includes(severity as Severity)) throw new Error(`${label}.severity is invalid`);
  const decision = nonEmptyString(parsed.decision, `${label}.decision`);
  if (decision !== "not-affected" && decision !== "temporary-risk-acceptance") {
    throw new Error(`${label}.decision is invalid`);
  }
  const expires = nonEmptyString(parsed.expires, `${label}.expires`);
  const expiresAt = new Date(`${expires}T23:59:59.999Z`);
  if (
    !ISO_DATE.test(expires) ||
    Number.isNaN(expiresAt.valueOf()) ||
    expiresAt.toISOString().slice(0, 10) !== expires
  ) {
    throw new Error(`${label}.expires must use YYYY-MM-DD`);
  }
  if (expiresAt.valueOf() < now.valueOf()) throw new Error(`${label} expired on ${expires}`);
  const currentDate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const maximumExpiry = currentDate + (MAX_EXCEPTION_LIFETIME_DAYS + 1) * 24 * 60 * 60 * 1000 - 1;
  if (expiresAt.valueOf() > maximumExpiry) {
    throw new Error(`${label}.expires must be within ${MAX_EXCEPTION_LIFETIME_DAYS} days`);
  }
  const trackingIssue = nonEmptyString(parsed.trackingIssue, `${label}.trackingIssue`);
  if (!NEMOCLAW_TRACKING_URL.test(trackingIssue)) {
    throw new Error(`${label}.trackingIssue must identify a NemoClaw issue or PR`);
  }
  const controls = parsed.compensatingControls;
  if (
    controls !== undefined &&
    (!Array.isArray(controls) ||
      controls.length === 0 ||
      controls.some((control) => typeof control !== "string" || !control.trim()))
  ) {
    throw new Error(`${label}.compensatingControls must contain non-empty strings`);
  }
  if (decision === "temporary-risk-acceptance" && controls === undefined) {
    throw new Error(`${label}.compensatingControls is required for temporary risk acceptance`);
  }

  return {
    advisory,
    decision,
    expires,
    graph,
    installedVersion: nonEmptyString(parsed.installedVersion, `${label}.installedVersion`),
    owner: nonEmptyString(parsed.owner, `${label}.owner`),
    package: nonEmptyString(parsed.package, `${label}.package`),
    rationale: nonEmptyString(parsed.rationale, `${label}.rationale`),
    severity: severity as Severity,
    trackingIssue,
    ...(controls === undefined ? {} : { compensatingControls: controls as string[] }),
  };
}

export function parseAuditExceptionRegistry(
  source: string,
  now = new Date(),
): AuditExceptionRegistry {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`npm audit exception registry is invalid JSON: ${String(error)}`);
  }
  const parsed = asRecord(value, "npm audit exception registry");
  requireExactKeys(
    parsed,
    new Set(["exceptions", "schemaVersion"]),
    "npm audit exception registry",
  );
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.exceptions)) {
    throw new Error(
      "npm audit exception registry must use schemaVersion 1 and an exceptions array",
    );
  }
  const exceptions = parsed.exceptions.map((entry, index) => parseException(entry, index, now));
  const identities = new Set<string>();
  for (const exception of exceptions) {
    const identity = [
      exception.graph,
      exception.advisory,
      exception.package,
      exception.installedVersion,
    ].join(":");
    if (identities.has(identity)) throw new Error(`duplicate npm audit exception: ${identity}`);
    identities.add(identity);
  }
  return { schemaVersion: 1, exceptions };
}

export function readAuditExceptionRegistry(
  filename: string,
  now = new Date(),
): Readonly<{ policy: AuditExceptionRegistry; sha256: string }> {
  const source = fs.readFileSync(filename, "utf-8");
  return {
    policy: parseAuditExceptionRegistry(source, now),
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

export function assertExceptionGraphs(
  registry: AuditExceptionRegistry,
  graphIds: ReadonlySet<string>,
): void {
  const unknown = [...new Set(registry.exceptions.map((entry) => entry.graph))].filter(
    (graph) => !graphIds.has(graph),
  );
  if (unknown.length > 0)
    throw new Error(`npm audit exceptions use unknown graphs: ${unknown.join(", ")}`);
}

export function parseAuditReport(result: {
  status: number | null;
  stderr: string;
  stdout: string;
}): Record<string, unknown> {
  if (!result.stdout.trim()) throw new Error(`npm audit did not produce JSON: ${result.stderr}`);
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
  const metadata = asRecord(report.metadata, "npm audit report metadata");
  const vulnerabilities = asRecord(
    metadata.vulnerabilities,
    "npm audit report metadata.vulnerabilities",
  );
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

export function deriveAuditEndpoints(configuredRegistry: string): AuditEndpoints {
  const candidate = configuredRegistry.trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      configuredRegistry: null,
      bulkAdvisoryEndpoint: null,
      note: "the configured registry could not be safely recorded for this run, so the audit endpoint is unknown.",
    };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      configuredRegistry: null,
      bulkAdvisoryEndpoint: null,
      note: "the configured registry could not be safely recorded for this run, so the audit endpoint is unknown.",
    };
  }
  parsed.username = "";
  parsed.password = "";
  const safeRegistry = parsed.toString();
  const base = safeRegistry.replace(/\/+$/, "");
  return {
    configuredRegistry: safeRegistry,
    bulkAdvisoryEndpoint: `${base}/-/npm/v1/security/advisories/bulk`,
    note: "npm audit posts the dependency graph to the bulk advisory endpoint of the configured registry; on request failure npm reports no advisory data.",
  };
}

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

function configuredNpmRegistry(directory: string): string {
  const result = spawnSync("npm", ["config", "get", "registry"], {
    cwd: directory,
    encoding: "utf-8",
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.error || result.status !== 0 ? "" : result.stdout.trim();
}

function advisoryId(value: Readonly<Record<string, unknown>>): string {
  const url = nonEmptyString(value.url, "npm audit advisory URL");
  const match = url.match(/\/advisories\/([^/]+)$/u);
  if (match?.[1] && ADVISORY_ID.test(match[1])) return match[1];
  const source = value.source;
  if (typeof source === "number" && Number.isSafeInteger(source) && source > 0) {
    return `NPM-${source}`;
  }
  throw new Error(`npm audit advisory has no supported identifier: ${url}`);
}

function installedVersion(directory: string, node: string, expectedPackage: string): string {
  if (!node.startsWith("node_modules/") || node.split("/").includes("..")) {
    throw new Error(`npm audit reported an unsafe dependency node: ${node}`);
  }
  const root = path.resolve(directory);
  const packageJson = path.resolve(root, node, "package.json");
  if (!packageJson.startsWith(`${root}${path.sep}`)) {
    throw new Error(`npm audit dependency node escapes the audited graph: ${node}`);
  }
  const metadata = asRecord(
    JSON.parse(fs.readFileSync(packageJson, "utf-8")),
    `installed package metadata for ${node}`,
  );
  if (metadata.name !== expectedPackage) {
    throw new Error(
      `npm audit node ${node} contains ${String(metadata.name)}, expected ${expectedPackage}`,
    );
  }
  return nonEmptyString(metadata.version, `installed version for ${node}`);
}

function vulnerabilityEntries(
  report: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const parsed = asRecord(report.vulnerabilities, "npm audit report vulnerabilities");
  return Object.fromEntries(
    Object.entries(parsed).map(([name, value]) => [
      name,
      asRecord(value, `npm audit finding ${name}`),
    ]),
  );
}

function directBlockingFindings(
  report: Record<string, unknown>,
  directory: string,
  threshold: Severity,
): DirectFinding[] {
  const entries = vulnerabilityEntries(report);
  const thresholdIndex = SEVERITIES.indexOf(threshold);
  const direct = new Map<string, DirectFinding>();
  const directIdsByPackage = new Map<string, Set<string>>();

  for (const [packageName, entry] of Object.entries(entries)) {
    if (!Array.isArray(entry.via) || !Array.isArray(entry.nodes)) {
      throw new Error(`npm audit finding ${packageName} has invalid via or nodes data`);
    }
    for (const via of entry.via) {
      if (typeof via === "string") continue;
      const advisory = asRecord(via, `npm audit advisory for ${packageName}`);
      const severity = nonEmptyString(
        advisory.severity,
        `npm audit advisory severity for ${packageName}`,
      );
      if (!SEVERITIES.includes(severity as Severity)) {
        throw new Error(`npm audit advisory for ${packageName} has invalid severity`);
      }
      if (SEVERITIES.indexOf(severity as Severity) < thresholdIndex) continue;
      const id = advisoryId(advisory);
      const ids = directIdsByPackage.get(packageName) ?? new Set<string>();
      ids.add(id);
      directIdsByPackage.set(packageName, ids);
      for (const node of entry.nodes) {
        if (typeof node !== "string")
          throw new Error(`npm audit finding ${packageName} has an invalid node`);
        const version = installedVersion(directory, node, packageName);
        direct.set(`${id}:${packageName}:${version}`, {
          advisory: id,
          installedVersion: version,
          package: packageName,
          severity: severity as Severity,
        });
      }
    }
  }

  function tracedBlockingAdvisories(
    packageName: string,
    visited: ReadonlySet<string>,
  ): Set<string> {
    if (visited.has(packageName))
      throw new Error(`npm audit meta-vulnerability cycle at ${packageName}`);
    const own = directIdsByPackage.get(packageName);
    if (own?.size) return new Set(own);
    const entry = entries[packageName];
    if (!entry || !Array.isArray(entry.via)) return new Set();
    const nextVisited = new Set(visited).add(packageName);
    return new Set(
      entry.via.flatMap((via) =>
        typeof via === "string" ? [...tracedBlockingAdvisories(via, nextVisited)] : [],
      ),
    );
  }

  for (const [packageName, entry] of Object.entries(entries)) {
    const severity = nonEmptyString(
      entry.severity,
      `npm audit finding severity for ${packageName}`,
    );
    if (!SEVERITIES.includes(severity as Severity)) {
      throw new Error(`npm audit finding ${packageName} has invalid severity`);
    }
    if (SEVERITIES.indexOf(severity as Severity) < thresholdIndex) continue;
    if (tracedBlockingAdvisories(packageName, new Set()).size === 0) {
      throw new Error(`npm audit blocking finding ${packageName} has no traceable advisory`);
    }
  }
  return [...direct.values()].sort((left, right) =>
    [left.advisory, left.package, left.installedVersion]
      .join(":")
      .localeCompare([right.advisory, right.package, right.installedVersion].join(":")),
  );
}

export function evaluateAuditPolicy(
  options: Readonly<{
    directory: string;
    exceptionPolicy: AuditExceptionRegistry;
    exceptionPolicySha256: string;
    graph: string;
    report: Record<string, unknown>;
    threshold: Severity;
  }>,
): AuditPolicyResult {
  const findings = directBlockingFindings(options.report, options.directory, options.threshold);
  const relevantExceptions = options.exceptionPolicy.exceptions.filter(
    (entry) => entry.graph === options.graph,
  );
  const used = new Set<AuditException>();
  const unaccepted = findings.filter((finding) => {
    const matched = relevantExceptions.find(
      (entry) =>
        entry.advisory === finding.advisory &&
        entry.package === finding.package &&
        entry.installedVersion === finding.installedVersion &&
        entry.severity === finding.severity,
    );
    if (matched) used.add(matched);
    return matched === undefined;
  });
  const unused = relevantExceptions.filter((entry) => !used.has(entry));
  if (unused.length > 0) {
    throw new Error(
      `${options.graph}: unused npm audit exceptions: ${unused.map((entry) => entry.advisory).join(", ")}`,
    );
  }
  const acceptedAdvisories = [...new Set([...used].map((entry) => entry.advisory))].sort();
  return {
    acceptedAdvisories,
    blockingThreshold: options.threshold,
    exceptionPolicySha256: options.exceptionPolicySha256,
    graph: options.graph,
    reported: vulnerabilityCounts(options.report),
    schemaVersion: 1,
    status: unaccepted.length > 0 ? "blocked" : used.size > 0 ? "accepted-exceptions" : "clean",
    unacceptedBlockingAdvisories: unaccepted,
  };
}

export function runReviewedNpmAudit(
  options: Readonly<{
    directory: string;
    exceptionFile: string;
    graph: string;
    provenance?: AuditProvenanceContext;
    reportFile?: string;
    resultFile?: string;
    threshold: Severity;
    throwOnBlock?: boolean;
  }>,
): AuditPolicyResult {
  if (options.provenance && !options.reportFile) {
    throw new Error("reviewed npm audit provenance requires a report file");
  }
  const exceptionRegistry = readAuditExceptionRegistry(options.exceptionFile);
  const startedAt = new Date().toISOString();
  const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd: options.directory,
    encoding: "utf-8",
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const finishedAt = new Date().toISOString();
  if (result.error) throw result.error;
  if (options.reportFile) fs.writeFileSync(options.reportFile, result.stdout);
  let report: Record<string, unknown> = {};
  let auditFailure: Error | undefined;
  try {
    report = parseAuditReport(result);
  } catch (error) {
    auditFailure = error instanceof Error ? error : new Error(String(error));
  }
  if (options.provenance && options.reportFile) {
    const provenance = buildAuditProvenance({
      failure: auditFailure?.message,
      finishedAt,
      label: options.provenance.label,
      nodeVersion: options.provenance.nodeVersion,
      npmVersion: options.provenance.npmVersion,
      packageSpecs: options.provenance.packageSpecs,
      rawReportPath: path.basename(options.reportFile),
      registry: configuredNpmRegistry(options.directory),
      report,
      startedAt,
    });
    fs.writeFileSync(
      provenanceSidecarPath(options.reportFile),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
  }
  if (auditFailure) throw auditFailure;
  const policyResult = evaluateAuditPolicy({
    directory: options.directory,
    exceptionPolicy: exceptionRegistry.policy,
    exceptionPolicySha256: exceptionRegistry.sha256,
    graph: options.graph,
    report,
    threshold: options.threshold,
  });
  if (options.resultFile)
    fs.writeFileSync(options.resultFile, `${JSON.stringify(policyResult, null, 2)}\n`);
  const summary = SEVERITIES.map(
    (severity) => `${severity}=${policyResult.reported[severity]}`,
  ).join(" ");
  console.log(`${options.graph}: ${summary} status=${policyResult.status}`);
  if ((options.throwOnBlock ?? true) && policyResult.unacceptedBlockingAdvisories.length > 0) {
    throw new Error(
      `${options.graph}: unaccepted npm audit findings at or above ${options.threshold}: ${policyResult.unacceptedBlockingAdvisories.map((finding) => finding.advisory).join(", ")}`,
    );
  }
  return policyResult;
}

function parseCliArgs(args: readonly string[]): {
  directory: string;
  exceptionFile: string;
  graph: string;
  reportFile?: string;
  resultFile?: string;
  threshold: Severity;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error("invalid reviewed npm audit arguments");
    if (values.has(key)) throw new Error(`duplicate reviewed npm audit argument: ${key}`);
    values.set(key, value);
  }
  const allowed = new Set([
    "--directory",
    "--exceptions",
    "--graph",
    "--report",
    "--result",
    "--threshold",
  ]);
  const unknown = [...values.keys()].filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(`unknown reviewed npm audit arguments: ${unknown.join(", ")}`);
  const directory = values.get("--directory");
  const exceptionFile = values.get("--exceptions");
  const graph = values.get("--graph");
  const threshold = values.get("--threshold");
  if (!directory || !exceptionFile || !graph || !threshold) {
    throw new Error(
      "reviewed npm audit requires --directory, --exceptions, --graph, and --threshold",
    );
  }
  if (!SEVERITIES.includes(threshold as Severity))
    throw new Error("reviewed npm audit threshold is invalid");
  return {
    directory,
    exceptionFile,
    graph,
    threshold: threshold as Severity,
    ...(values.has("--report") ? { reportFile: values.get("--report") } : {}),
    ...(values.has("--result") ? { resultFile: values.get("--result") } : {}),
  };
}

function isMainModule(): boolean {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    : false;
}

if (isMainModule()) {
  try {
    runReviewedNpmAudit(parseCliArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
