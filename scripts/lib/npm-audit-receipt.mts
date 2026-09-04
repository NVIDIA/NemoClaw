#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateAuditPolicy,
  parseAuditExceptionRegistry,
  parseAuditReport,
  NPM_AUDIT_ARGV,
} from "./reviewed-npm-audit.mts";

export const AUDIT_ARGV = NPM_AUDIT_ARGV;
// Remove this PR-only compatibility after main produces Yarn-bound audit receipts.
const LEGACY_NPM_AUDIT_REGISTRY = "https://registry.npmjs.org/";
const LEGACY_NPM_AUDIT_ARGV = ["audit", "--omit=dev", "--json"] as const;
export const LEGACY_NPM_AUDIT_RECEIPT_DEADLINE = Date.parse("2026-09-11T00:00:00.000Z");
export const RECEIPT_LIFETIME_MS = 12 * 60 * 60 * 1000 - 1;
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);
const RECEIPT_KEYS = [
  "acceptedAdvisoryIds",
  "argv",
  "blockingAdvisoryIds",
  "createdAt",
  "exceptionPolicySha256",
  "expiresAt",
  "graphId",
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
  npmVersion: string;
  packageJsonSha256: string;
  packageLockSha256: string;
  rawResponseSha256: string;
  registryOrigin: string;
  result: "pass";
  schemaVersion: 1;
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
    npmVersion: string;
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
  return {
    acceptedAdvisoryIds: [...new Set(options.acceptedAdvisoryIds)].sort(),
    argv: [...AUDIT_ARGV],
    blockingAdvisoryIds: [],
    createdAt: created.toISOString(),
    exceptionPolicySha256: options.exceptionPolicySha256,
    expiresAt: new Date(created.getTime() + RECEIPT_LIFETIME_MS).toISOString(),
    graphId: options.graphId,
    npmVersion: options.npmVersion,
    packageJsonSha256: sha256(options.packageJson),
    packageLockSha256: sha256(options.packageLock),
    rawResponseSha256: sha256(options.rawResponse),
    registryOrigin: options.registryOrigin,
    result: "pass",
    schemaVersion: 1,
    severityThreshold: options.severityThreshold,
  };
}

export function parseAndVerifyAuditReceipt(
  contents: string,
  expected: Readonly<{
    graphId: string;
    npmVersion: string;
    exceptionPolicy: string | Buffer;
    severityThreshold: AuditReceipt["severityThreshold"];
    packageJson: string | Buffer;
    packageLock: string | Buffer;
    rawResponse: string | Buffer;
    registryOrigin: string;
    now?: Date;
    allowLegacyNpmjsReceipt?: boolean;
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
  if (value.schemaVersion !== 1 || value.result !== "pass")
    throw new Error("receipt is not a passing schema version 1 receipt");
  if (value.graphId !== expected.graphId || value.npmVersion !== expected.npmVersion)
    throw new Error("receipt identity does not match expected graph and npm");
  const now = (expected.now ?? new Date()).getTime();
  const currentContract =
    value.registryOrigin === expected.registryOrigin &&
    Array.isArray(value.argv) &&
    value.argv.length === AUDIT_ARGV.length &&
    value.argv.every((arg, index) => arg === AUDIT_ARGV[index]);
  const legacyContract =
    expected.allowLegacyNpmjsReceipt === true &&
    now < LEGACY_NPM_AUDIT_RECEIPT_DEADLINE &&
    value.registryOrigin === LEGACY_NPM_AUDIT_REGISTRY &&
    Array.isArray(value.argv) &&
    value.argv.length === LEGACY_NPM_AUDIT_ARGV.length &&
    value.argv.every((arg, index) => arg === LEGACY_NPM_AUDIT_ARGV[index]);
  if (!currentContract && !legacyContract)
    throw new Error("receipt npm audit registry and arguments do not match an allowed contract");
  const accepted = stringArray(value.acceptedAdvisoryIds, "acceptedAdvisoryIds");
  const blocking = stringArray(value.blockingAdvisoryIds, "blockingAdvisoryIds");
  if (blocking.length !== 0) throw new Error("passing receipt contains blocking advisories");
  for (const [key, actual] of [
    ["packageJsonSha256", sha256(expected.packageJson)],
    ["packageLockSha256", sha256(expected.packageLock)],
  ] as const) {
    if (value[key] !== actual) throw new Error(`receipt ${key} does not match`);
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
        "usage: npm-audit-receipt.mts --receipt FILE --package-json FILE --package-lock FILE --raw-report FILE --exceptions FILE --graph ID --npm-version VERSION --registry ORIGIN --threshold SEVERITY [--legacy-npmjs true]",
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
    "--npm-version",
    "--registry",
    "--threshold",
  ];
  const allowed = [...required, "--result", "--legacy-npmjs"];
  exactKeys(
    Object.fromEntries(
      [...values].filter(([key]) => key !== "--result" && key !== "--legacy-npmjs"),
    ),
    required,
    "verifier arguments",
  );
  if ([...values.keys()].some((key) => !allowed.includes(key)))
    throw new Error("verifier arguments has unexpected or missing keys");
  const packageJson = fs.readFileSync(values.get("--package-json")!);
  const packageLock = fs.readFileSync(values.get("--package-lock")!);
  const rawResponse = fs.readFileSync(values.get("--raw-report")!);
  const exceptionPolicy = fs.readFileSync(values.get("--exceptions")!);
  parseAndVerifyAuditReceipt(fs.readFileSync(values.get("--receipt")!, "utf8"), {
    graphId: values.get("--graph")!,
    npmVersion: values.get("--npm-version")!,
    exceptionPolicy,
    severityThreshold: values.get("--threshold")! as AuditReceipt["severityThreshold"],
    packageJson,
    packageLock,
    rawResponse,
    registryOrigin: values.get("--registry")!,
    allowLegacyNpmjsReceipt: values.get("--legacy-npmjs") === "true",
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
  console.log("reviewed npm audit receipt and current policy verified");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
