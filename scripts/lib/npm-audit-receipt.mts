#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ReviewedNpmIdentity,
  evaluateAuditPolicy,
  parseReviewedNpmIdentity,
  parseAuditExceptionRegistry,
  parseAuditReport,
  NPM_AUDIT_ARGV,
  parseReviewedNpmIdentityConfig,
} from "./reviewed-npm-audit.mts";

export const AUDIT_ARGV = NPM_AUDIT_ARGV;
export const RECEIPT_LIFETIME_MS = 12 * 60 * 60 * 1000 - 1;
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);
const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_NPM_PACKAGE_SPEC =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const RECEIPT_KEYS = [
  "acceptedAdvisoryIds",
  "argv",
  "blockingAdvisoryIds",
  "createdAt",
  "exceptionPolicySha256",
  "expiresAt",
  "graphId",
  "npmArchiveSha256",
  "npmIntegrity",
  "npmVersion",
  "packageJsonSha256",
  "packageLockSha256",
  "rawResponseSha256",
  "registryOrigin",
  "result",
  "schemaVersion",
  "severityThreshold",
];
export type AuditReceipt = Readonly<{
  acceptedAdvisoryIds: readonly string[];
  argv: readonly string[];
  blockingAdvisoryIds: readonly string[];
  createdAt: string;
  exceptionPolicySha256: string;
  expiresAt: string;
  graphId: string;
  npmArchiveSha256: string;
  npmIntegrity: string;
  npmVersion: string;
  packageJsonSha256: string;
  packageLockSha256: string;
  rawResponseSha256: string;
  registryOrigin: string;
  result: "pass";
  schemaVersion: 2;
  severityThreshold: "info" | "low" | "moderate" | "high" | "critical";
}>;

export function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected or missing keys`);
  }
}

function reviewedLockedGraphIdentity(value: Record<string, unknown>, graphId: string) {
  const { integrity, label, lockSha256, packageSpec, tarballUrl } = value;
  if (
    typeof integrity !== "string" ||
    integrity.length === 0 ||
    typeof label !== "string" ||
    label.length === 0 ||
    typeof lockSha256 !== "string" ||
    !SHA256.test(lockSha256) ||
    typeof packageSpec !== "string" ||
    !EXACT_NPM_PACKAGE_SPEC.test(packageSpec) ||
    typeof tarballUrl !== "string" ||
    tarballUrl.length === 0
  ) {
    throw new Error(`npm audit configuration has an invalid identity for ${graphId}`);
  }
  const name = packageSpec.slice(0, packageSpec.lastIndexOf("@"));
  return { lockSha256, name, packageSpec };
}

export function reviewedLockedGraphSha256s(contents: string, graphId: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("npm audit configuration is not valid JSON");
  }
  const record =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const lockedGraphs = record.lockedGraphs;
  if (!Array.isArray(lockedGraphs)) {
    throw new Error("npm audit configuration has no reviewed locked graphs");
  }
  const matches = lockedGraphs.filter(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).id === graphId,
  ) as Record<string, unknown>[];
  if (matches.length !== 1) {
    throw new Error(`npm audit configuration must contain one reviewed graph for ${graphId}`);
  }
  const graph = matches[0]!;
  const primary = reviewedLockedGraphIdentity(graph, graphId);
  const replacement = graph.replacement;
  if (
    replacement !== undefined &&
    (typeof replacement !== "object" || replacement === null || Array.isArray(replacement))
  ) {
    throw new Error(`npm audit configuration has an invalid replacement for ${graphId}`);
  }
  if (replacement === undefined) return [primary.lockSha256];
  const next = reviewedLockedGraphIdentity(replacement as Record<string, unknown>, graphId);
  if (next.name !== primary.name || next.packageSpec === primary.packageSpec) {
    throw new Error(`npm audit configuration has an invalid replacement for ${graphId}`);
  }
  if (next.lockSha256 === primary.lockSha256) {
    throw new Error(`npm audit configuration has duplicate reviewed lock digests for ${graphId}`);
  }
  return [primary.lockSha256, next.lockSha256];
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string") ||
    new Set(value).size !== value.length ||
    [...value].sort().some((item, index) => item !== value[index])
  ) {
    throw new Error(`${label} must be a sorted array of unique strings`);
  }
  return value;
}

function utcInstant(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    throw new Error(`${label} must be a canonical UTC timestamp`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new Error(`${label} must be a valid UTC timestamp`);
  return time;
}

export function createAuditReceipt(
  options: Readonly<{
    acceptedAdvisoryIds: readonly string[];
    blockingAdvisoryIds: readonly string[];
    createdAt?: Date;
    exceptionPolicySha256: string;
    graphId: string;
    reviewedNpmIdentity: ReviewedNpmIdentity;
    packageJson: string | Buffer;
    packageLock: string | Buffer;
    rawResponse: string | Buffer;
    registryOrigin: string;
    severityThreshold: AuditReceipt["severityThreshold"];
  }>,
): AuditReceipt {
  if (options.blockingAdvisoryIds.length > 0)
    throw new Error("cannot issue a passing receipt with blocking advisories");
  const created = options.createdAt ?? new Date();
  const reviewedNpmIdentity = parseReviewedNpmIdentity(options.reviewedNpmIdentity);
  return {
    acceptedAdvisoryIds: [...new Set(options.acceptedAdvisoryIds)].sort(),
    argv: [...AUDIT_ARGV],
    blockingAdvisoryIds: [],
    createdAt: created.toISOString(),
    exceptionPolicySha256: options.exceptionPolicySha256,
    expiresAt: new Date(created.getTime() + RECEIPT_LIFETIME_MS).toISOString(),
    graphId: options.graphId,
    ...reviewedNpmIdentity,
    packageJsonSha256: sha256(options.packageJson),
    packageLockSha256: sha256(options.packageLock),
    rawResponseSha256: sha256(options.rawResponse),
    registryOrigin: options.registryOrigin,
    result: "pass",
    schemaVersion: 2,
    severityThreshold: options.severityThreshold,
  };
}

export function parseAndVerifyAuditReceipt(
  contents: string,
  expected: Readonly<{
    approvedPackageLockSha256s: readonly string[];
    graphId: string;
    reviewedNpmIdentity: ReviewedNpmIdentity;
    exceptionPolicy: string | Buffer;
    severityThreshold: AuditReceipt["severityThreshold"];
    packageJson: string | Buffer;
    packageLock: string | Buffer;
    rawResponse: string | Buffer;
    registryOrigin: string;
    now?: Date;
  }>,
): AuditReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("receipt is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("receipt must be an object");
  const value = parsed as Record<string, unknown>;
  exactKeys(value, RECEIPT_KEYS, "receipt");
  if (value.schemaVersion !== 2 || value.result !== "pass")
    throw new Error("receipt is not a passing schema version 2 receipt");
  const now = (expected.now ?? new Date()).getTime();
  const reviewedNpmIdentity = parseReviewedNpmIdentity(expected.reviewedNpmIdentity);
  if (
    expected.approvedPackageLockSha256s.length === 0 ||
    expected.approvedPackageLockSha256s.some((digest) => !SHA256.test(digest)) ||
    new Set(expected.approvedPackageLockSha256s).size !== expected.approvedPackageLockSha256s.length
  ) {
    throw new Error("expected reviewed package lock digests are invalid");
  }
  if (
    value.graphId !== expected.graphId ||
    value.npmVersion !== reviewedNpmIdentity.npmVersion ||
    value.npmIntegrity !== reviewedNpmIdentity.npmIntegrity ||
    value.npmArchiveSha256 !== reviewedNpmIdentity.npmArchiveSha256
  ) {
    throw new Error("receipt identity does not match expected graph and reviewed npm");
  }
  if (
    value.registryOrigin !== expected.registryOrigin ||
    !Array.isArray(value.argv) ||
    value.argv.length !== AUDIT_ARGV.length ||
    value.argv.some((arg, index) => arg !== AUDIT_ARGV[index])
  ) {
    throw new Error("receipt npm audit registry and arguments do not match the reviewed contract");
  }
  const accepted = stringArray(value.acceptedAdvisoryIds, "acceptedAdvisoryIds");
  const blocking = stringArray(value.blockingAdvisoryIds, "blockingAdvisoryIds");
  if (blocking.length !== 0) throw new Error("passing receipt contains blocking advisories");
  for (const [key, actual] of [
    ["packageJsonSha256", sha256(expected.packageJson)],
    ["packageLockSha256", sha256(expected.packageLock)],
  ] as const) {
    if (value[key] !== actual) throw new Error(`receipt ${key} does not match`);
  }
  if (!expected.approvedPackageLockSha256s.includes(value.packageLockSha256 as string)) {
    throw new Error("receipt packageLockSha256 is not a reviewed lock digest");
  }
  if (value.exceptionPolicySha256 !== sha256(expected.exceptionPolicy))
    throw new Error("receipt exceptionPolicySha256 does not match");
  if (value.rawResponseSha256 !== sha256(expected.rawResponse))
    throw new Error("receipt rawResponseSha256 does not match");
  if (
    value.severityThreshold !== expected.severityThreshold ||
    !SEVERITIES.has(expected.severityThreshold)
  )
    throw new Error("receipt severityThreshold does not match");
  const created = utcInstant(value.createdAt, "createdAt");
  const expires = utcInstant(value.expiresAt, "expiresAt");
  if (expires <= created || expires - created >= 12 * 60 * 60 * 1000)
    throw new Error("receipt lifetime must be positive and less than 12 hours");
  if (created - now > MAX_FUTURE_SKEW_MS)
    throw new Error("receipt creation time is too far in the future");
  if (now >= expires) throw new Error("receipt is expired");
  return {
    ...(value as AuditReceipt),
    acceptedAdvisoryIds: accepted,
    blockingAdvisoryIds: blocking,
  };
}

export function canonicalAuditReceipt(receipt: AuditReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function cli(args: readonly string[]): void {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (!args[index]?.startsWith("--") || value === undefined)
      throw new Error(
        "usage: npm-audit-receipt.mts --receipt FILE --package-json FILE --package-lock FILE --raw-report FILE --exceptions FILE --graph ID --audit-config FILE --registry ORIGIN --threshold SEVERITY [--result FILE]",
      );
    values.set(args[index], value);
  }
  const required = [
    "--receipt",
    "--package-json",
    "--package-lock",
    "--raw-report",
    "--exceptions",
    "--graph",
    "--audit-config",
    "--registry",
    "--threshold",
  ];
  const allowed = [...required, "--result"];
  exactKeys(
    Object.fromEntries([...values].filter(([key]) => key !== "--result")),
    required,
    "verifier arguments",
  );
  if ([...values.keys()].some((key) => !allowed.includes(key)))
    throw new Error("verifier arguments has unexpected or missing keys");
  const packageJson = fs.readFileSync(values.get("--package-json")!);
  const packageLock = fs.readFileSync(values.get("--package-lock")!);
  const rawResponse = fs.readFileSync(values.get("--raw-report")!);
  const exceptionPolicy = fs.readFileSync(values.get("--exceptions")!);
  const auditConfig = fs.readFileSync(values.get("--audit-config")!, "utf8");
  const graphId = values.get("--graph")!;
  const reviewedNpmIdentity = parseReviewedNpmIdentityConfig(auditConfig);
  parseAndVerifyAuditReceipt(fs.readFileSync(values.get("--receipt")!, "utf8"), {
    approvedPackageLockSha256s: reviewedLockedGraphSha256s(auditConfig, graphId),
    graphId,
    reviewedNpmIdentity,
    exceptionPolicy,
    severityThreshold: values.get("--threshold")! as AuditReceipt["severityThreshold"],
    packageJson,
    packageLock,
    rawResponse,
    registryOrigin: values.get("--registry")!,
  });
  const policyResult = evaluateAuditPolicy({
    directory: path.dirname(values.get("--package-json")!),
    exceptionPolicy: parseAuditExceptionRegistry(exceptionPolicy.toString("utf8")),
    exceptionPolicySha256: sha256(exceptionPolicy),
    graph: values.get("--graph")!,
    report: parseAuditReport({ status: 0, stderr: "", stdout: rawResponse.toString("utf8") }),
    threshold: values.get("--threshold")! as AuditReceipt["severityThreshold"],
  });
  if (policyResult.unacceptedBlockingAdvisories.length > 0)
    throw new Error(
      `${values.get("--graph")}: cached raw audit report fails current exception policy`,
    );
  if (values.has("--result"))
    fs.writeFileSync(values.get("--result")!, `${JSON.stringify(policyResult, null, 2)}\n`);
  console.log("npm audit receipt and current policy verified");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
