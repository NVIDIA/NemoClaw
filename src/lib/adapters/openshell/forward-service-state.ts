// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { openRegularFileNoFollow } from "../fs/regular-file";
import { ensureConfigDir, writeConfigFile } from "../../state/config-io";
import {
  forwardServiceReceiptPath,
  isForwardServiceReceipt,
  type ForwardServiceReceipt,
  type ForwardServiceTarget,
} from "./forward-service";

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_RECEIPT_FILES = 1_024;

export interface ForwardServiceStateOptions {
  readonly stateDirectory: string;
  readonly uid?: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function requiredUid(options: ForwardServiceStateOptions): number {
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
    throw new Error("OpenShell forward service state requires a current-user identity");
  }
  return Number(uid);
}

function receiptPath(target: ForwardServiceTarget, options: ForwardServiceStateOptions): string {
  return forwardServiceReceiptPath(options.stateDirectory, target);
}

function assertOwnerOnlyDirectory(directory: string, options: ForwardServiceStateOptions): void {
  const stat = fs.lstatSync(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== requiredUid(options) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("OpenShell forward service state directory is not owner-only");
  }
}

function ensureForwardStateDirectory(
  target: ForwardServiceTarget,
  options: ForwardServiceStateOptions,
): string {
  const directory = path.dirname(receiptPath(target, options));
  ensureConfigDir(directory);
  assertOwnerOnlyDirectory(options.stateDirectory, options);
  assertOwnerOnlyDirectory(directory, options);
  return directory;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameReceiptGeneration(
  actual: ForwardServiceReceipt,
  expected: ForwardServiceReceipt,
): boolean {
  return (
    actual.pid === expected.pid &&
    actual.processIdentity === expected.processIdentity &&
    actual.hostIdentity === expected.hostIdentity &&
    actual.pidNamespaceIdentity === expected.pidNamespaceIdentity &&
    actual.sandboxIdentityFingerprint === expected.sandboxIdentityFingerprint &&
    actual.gatewayName === expected.gatewayName &&
    actual.localHost === expected.localHost &&
    actual.localPort === expected.localPort &&
    actual.targetHost === expected.targetHost &&
    actual.targetPort === expected.targetPort
  );
}

export function readForwardServiceReceipt(
  target: ForwardServiceTarget,
  options: ForwardServiceStateOptions,
): ForwardServiceReceipt | null {
  const filePath = receiptPath(target, options);
  try {
    assertOwnerOnlyDirectory(options.stateDirectory, options);
    assertOwnerOnlyDirectory(path.dirname(filePath), options);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  return readForwardServiceReceiptFile(filePath, options);
}

function readForwardServiceReceiptFile(
  filePath: string,
  options: ForwardServiceStateOptions,
): ForwardServiceReceipt | null {
  let opened: ReturnType<typeof openRegularFileNoFollow>;
  try {
    opened = openRegularFileNoFollow(filePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const stat = opened.stat();
    if (stat.uid !== requiredUid(options) || (stat.mode & 0o077) !== 0) {
      throw new Error("OpenShell forward service receipt is not owner-only");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(opened.readBytes(MAX_RECEIPT_BYTES).toString("utf8"));
    } catch {
      throw new Error("OpenShell forward service receipt is invalid");
    }
    if (!isForwardServiceReceipt(parsed)) {
      throw new Error("OpenShell forward service receipt is invalid");
    }
    if (receiptPath(parsed, options) !== filePath) {
      throw new Error("OpenShell forward service receipt path does not match its target");
    }
    return parsed;
  } finally {
    opened.close();
  }
}

/** Enumerate only exact owner-only receipts; any ambiguous entry fails closed. */
export function listForwardServiceReceipts(
  options: ForwardServiceStateOptions,
): ForwardServiceReceipt[] {
  const directory = path.join(options.stateDirectory, "forwards");
  try {
    assertOwnerOnlyDirectory(options.stateDirectory, options);
    assertOwnerOnlyDirectory(directory, options);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > MAX_RECEIPT_FILES) {
    throw new Error("OpenShell forward service state contains too many receipts");
  }
  const receipts: ForwardServiceReceipt[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("OpenShell forward service state contains a non-regular receipt");
    }
    const receipt = readForwardServiceReceiptFile(path.join(directory, entry.name), options);
    if (!receipt) {
      throw new Error("OpenShell forward service receipt disappeared during enumeration");
    }
    receipts.push(receipt);
  }
  return receipts;
}

export function writeForwardServiceReceipt(
  receipt: ForwardServiceReceipt,
  options: ForwardServiceStateOptions,
): void {
  if (!isForwardServiceReceipt(receipt)) {
    throw new Error("OpenShell forward service receipt is invalid");
  }
  ensureForwardStateDirectory(receipt, options);
  const filePath = receiptPath(receipt, options);
  writeConfigFile(filePath, receipt);
  const readBack = readForwardServiceReceipt(receipt, options);
  if (!readBack || !sameReceiptGeneration(readBack, receipt)) {
    throw new Error("OpenShell forward service receipt did not persist its process generation");
  }
}

export type RemoveForwardServiceReceiptResult = "absent" | "changed" | "removed";

/** Remove only the receipt generation that the caller already classified. */
export function removeForwardServiceReceipt(
  expected: ForwardServiceReceipt,
  options: ForwardServiceStateOptions,
): RemoveForwardServiceReceiptResult {
  const filePath = receiptPath(expected, options);
  const actual = readForwardServiceReceipt(expected, options);
  if (!actual) return "absent";
  if (!sameReceiptGeneration(actual, expected)) return "changed";

  const opened = openRegularFileNoFollow(filePath);
  const before = opened.stat();
  const quarantine = `${filePath}.removed.${randomUUID()}`;
  let removeQuarantine = false;
  try {
    const current = fs.lstatSync(filePath);
    if (!sameFileIdentity(before, current)) return "changed";
    fs.renameSync(filePath, quarantine);
    const quarantined = fs.lstatSync(quarantine);
    if (!sameFileIdentity(before, quarantined)) {
      if (!fs.existsSync(filePath)) fs.renameSync(quarantine, filePath);
      return "changed";
    }
    removeQuarantine = true;
    fs.rmSync(quarantine);
    return "removed";
  } finally {
    opened.close();
    if (removeQuarantine) fs.rmSync(quarantine, { force: true });
  }
}
