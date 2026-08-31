// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { isValidName } from "../../name-validation";

export const FORWARD_SERVICE_RECEIPT_SCHEMA_VERSION = 1 as const;
export const FORWARD_SERVICE_PENDING_SCHEMA_VERSION = 1 as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ForwardServiceTarget {
  readonly executable: string;
  readonly gatewayName: string;
  readonly workspace: "default";
  readonly sandboxName: string;
  readonly sandboxIdentityFingerprint: string;
  readonly localHost: "127.0.0.1" | "0.0.0.0";
  readonly localPort: number;
  readonly targetHost: "127.0.0.1";
  readonly targetPort: number;
}

export interface ForwardServiceReceipt extends ForwardServiceTarget {
  readonly schemaVersion: typeof FORWARD_SERVICE_RECEIPT_SCHEMA_VERSION;
  readonly pid: number;
  readonly uid: number;
  readonly processIdentity: string;
  readonly hostIdentity: string;
  readonly pidNamespaceIdentity: string | null;
  readonly argv: readonly string[];
  readonly startedAt: string;
}

/** Blocks a second spawn when a failed child survived before identity could be observed. */
export interface ForwardServicePendingReceipt extends ForwardServiceTarget {
  readonly pendingSchemaVersion: typeof FORWARD_SERVICE_PENDING_SCHEMA_VERSION;
  readonly pid: number;
  readonly launcherUid: number;
  readonly hostIdentity: string;
  readonly pidNamespaceIdentity: string | null;
  readonly expectedArgv: readonly string[];
  readonly startedAt: string;
}

export interface ForwardServiceProcessObservation {
  readonly alive: boolean;
  readonly uid: number | null;
  readonly processIdentity: string | null;
  readonly hostIdentity: string;
  readonly pidNamespaceIdentity: string | null;
  readonly argv: readonly string[] | null;
}

/** Only `owned` authorizes reuse or a signal. Every other result must fail closed. */
export type ForwardServiceReceiptDisposition = "owned" | "stale" | "foreign" | "unknown";

function isPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// The lifecycle caller derives this value through resolveSandboxGatewayName.
// Receipt parsing repeats only the fixed namespace and port bounds so corrupt
// state cannot turn process control into an arbitrary gateway command.
function isCanonicalNemoClawGatewayName(value: string): boolean {
  if (value === "nemoclaw") return true;
  const match = /^nemoclaw-([1-9]\d{0,4})$/u.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 && port !== 8080;
}

function sameArgv(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

export function validateForwardServiceTarget(target: ForwardServiceTarget): ForwardServiceTarget {
  if (!path.isAbsolute(target.executable) || target.executable.includes("\0")) {
    throw new Error("OpenShell forward service executable must be an absolute path");
  }
  if (!isCanonicalNemoClawGatewayName(target.gatewayName)) {
    throw new Error("OpenShell forward service gateway must be a canonical NemoClaw gateway");
  }
  if (target.workspace !== "default") {
    throw new Error("OpenShell forward service workspace must be default");
  }
  if (!isValidName(target.sandboxName)) {
    throw new Error("OpenShell forward service sandbox name is invalid");
  }
  if (!SHA256_PATTERN.test(target.sandboxIdentityFingerprint)) {
    throw new Error("OpenShell forward service requires an immutable sandbox identity fingerprint");
  }
  if (target.localHost !== "127.0.0.1" && target.localHost !== "0.0.0.0") {
    throw new Error("OpenShell forward service local host must be IPv4 loopback or all interfaces");
  }
  if (!isPort(target.localPort) || !isPort(target.targetPort)) {
    throw new Error("OpenShell forward service ports must be between 1 and 65535");
  }
  if (target.targetHost !== "127.0.0.1") {
    throw new Error("OpenShell forward service target host must be IPv4 loopback");
  }
  return target;
}

/** Build the released OpenShell 0.0.106 direct ForwardTcp command. */
export function buildForwardServiceArgs(target: ForwardServiceTarget): string[] {
  validateForwardServiceTarget(target);
  return [
    "--gateway",
    target.gatewayName,
    "--workspace",
    target.workspace,
    "forward",
    "service",
    target.sandboxName,
    "--target-port",
    String(target.targetPort),
    "--target-host",
    target.targetHost,
    "--local",
    `${target.localHost}:${String(target.localPort)}`,
  ];
}

export function forwardServiceReceiptPath(
  stateDirectory: string,
  target: ForwardServiceTarget,
): string {
  validateForwardServiceTarget(target);
  if (!path.isAbsolute(stateDirectory)) {
    throw new Error("OpenShell forward service state directory must be absolute");
  }
  return path.join(
    stateDirectory,
    "forwards",
    `${target.gatewayName}-${target.sandboxName}-${target.sandboxIdentityFingerprint}-${String(target.localPort)}.json`,
  );
}

export function forwardServicePendingReceiptPath(
  stateDirectory: string,
  target: ForwardServiceTarget,
): string {
  const receipt = forwardServiceReceiptPath(stateDirectory, target);
  return receipt.replace(/\.json$/u, ".pending.json");
}

export function isForwardServiceReceipt(value: unknown): value is ForwardServiceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "schemaVersion",
    "executable",
    "gatewayName",
    "workspace",
    "sandboxName",
    "sandboxIdentityFingerprint",
    "localHost",
    "localPort",
    "targetHost",
    "targetPort",
    "pid",
    "uid",
    "processIdentity",
    "hostIdentity",
    "pidNamespaceIdentity",
    "argv",
    "startedAt",
  ]);
  if (Object.keys(candidate).some((key) => !expectedKeys.has(key))) return false;
  if (
    candidate.schemaVersion !== FORWARD_SERVICE_RECEIPT_SCHEMA_VERSION ||
    !isNonEmptyString(candidate.executable) ||
    !isNonEmptyString(candidate.gatewayName) ||
    candidate.workspace !== "default" ||
    !isNonEmptyString(candidate.sandboxName) ||
    !isNonEmptyString(candidate.sandboxIdentityFingerprint) ||
    (candidate.localHost !== "127.0.0.1" && candidate.localHost !== "0.0.0.0") ||
    !isPort(candidate.localPort) ||
    candidate.targetHost !== "127.0.0.1" ||
    !isPort(candidate.targetPort) ||
    !Number.isSafeInteger(candidate.pid) ||
    Number(candidate.pid) <= 0 ||
    !Number.isSafeInteger(candidate.uid) ||
    Number(candidate.uid) < 0 ||
    !isNonEmptyString(candidate.processIdentity) ||
    !isNonEmptyString(candidate.hostIdentity) ||
    (candidate.pidNamespaceIdentity !== null &&
      !isNonEmptyString(candidate.pidNamespaceIdentity)) ||
    !Array.isArray(candidate.argv) ||
    candidate.argv.length === 0 ||
    candidate.argv.some((entry) => typeof entry !== "string" || entry.includes("\0")) ||
    !isNonEmptyString(candidate.startedAt)
  ) {
    return false;
  }
  try {
    validateForwardServiceTarget(candidate as unknown as ForwardServiceReceipt);
  } catch {
    return false;
  }
  return sameArgv(candidate.argv as string[], [
    candidate.executable as string,
    ...buildForwardServiceArgs(candidate as unknown as ForwardServiceReceipt),
  ]);
}

export function isForwardServicePendingReceipt(
  value: unknown,
): value is ForwardServicePendingReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "pendingSchemaVersion",
    "executable",
    "gatewayName",
    "workspace",
    "sandboxName",
    "sandboxIdentityFingerprint",
    "localHost",
    "localPort",
    "targetHost",
    "targetPort",
    "pid",
    "launcherUid",
    "hostIdentity",
    "pidNamespaceIdentity",
    "expectedArgv",
    "startedAt",
  ]);
  if (Object.keys(candidate).some((key) => !expectedKeys.has(key))) return false;
  if (
    candidate.pendingSchemaVersion !== FORWARD_SERVICE_PENDING_SCHEMA_VERSION ||
    !Number.isSafeInteger(candidate.pid) ||
    Number(candidate.pid) <= 0 ||
    !Number.isSafeInteger(candidate.launcherUid) ||
    Number(candidate.launcherUid) < 0 ||
    !isNonEmptyString(candidate.hostIdentity) ||
    (candidate.pidNamespaceIdentity !== null &&
      !isNonEmptyString(candidate.pidNamespaceIdentity)) ||
    !Array.isArray(candidate.expectedArgv) ||
    candidate.expectedArgv.some((entry) => typeof entry !== "string" || entry.includes("\0")) ||
    !isNonEmptyString(candidate.startedAt)
  ) {
    return false;
  }
  try {
    validateForwardServiceTarget(candidate as unknown as ForwardServicePendingReceipt);
  } catch {
    return false;
  }
  return sameArgv(candidate.expectedArgv as string[], [
    candidate.executable as string,
    ...buildForwardServiceArgs(candidate as unknown as ForwardServicePendingReceipt),
  ]);
}

function receiptMatchesTarget(
  receipt: ForwardServiceReceipt,
  target: ForwardServiceTarget,
): boolean {
  return (
    receipt.executable === target.executable &&
    receipt.gatewayName === target.gatewayName &&
    receipt.workspace === target.workspace &&
    receipt.sandboxName === target.sandboxName &&
    receipt.sandboxIdentityFingerprint === target.sandboxIdentityFingerprint &&
    receipt.localHost === target.localHost &&
    receipt.localPort === target.localPort &&
    receipt.targetHost === target.targetHost &&
    receipt.targetPort === target.targetPort
  );
}

/** Classify a receipt before any caller reuses or signals its process. */
export function classifyForwardServiceReceipt(
  receipt: ForwardServiceReceipt,
  target: ForwardServiceTarget,
  observation: ForwardServiceProcessObservation,
): ForwardServiceReceiptDisposition {
  validateForwardServiceTarget(target);
  if (!isForwardServiceReceipt(receipt) || !receiptMatchesTarget(receipt, target)) return "foreign";
  if (
    observation.hostIdentity !== receipt.hostIdentity ||
    observation.pidNamespaceIdentity !== receipt.pidNamespaceIdentity
  ) {
    return "foreign";
  }
  if (!observation.alive) return "stale";
  if (
    observation.uid === null ||
    observation.processIdentity === null ||
    observation.argv === null
  ) {
    return "unknown";
  }
  if (
    observation.uid !== receipt.uid ||
    observation.processIdentity !== receipt.processIdentity ||
    !sameArgv(observation.argv, receipt.argv)
  ) {
    return "stale";
  }
  return "owned";
}
