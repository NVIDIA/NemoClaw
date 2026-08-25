// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveHostNemoclawDir, writeConfigFile } from "../config-io";
import { normalizeSandboxQuarantineFence } from "./quarantine";
import type { SandboxQuarantineFence } from "./types";

const RECEIPT_DIRECTORY = "quarantine-receipts";
const MAX_RECEIPT_BYTES = 64 * 1_024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SandboxQuarantineReceipt {
  readonly schemaVersion: 1;
  readonly kind: "sandbox-quarantine-receipt";
  readonly status: "active" | "quarantined" | "partial" | "released";
  readonly fence: SandboxQuarantineFence;
  readonly completedAt: string | null;
  readonly releasedAt: string | null;
}

function sandboxDirectoryName(sandboxName: string): string {
  return createHash("sha256").update(sandboxName, "utf8").digest("hex");
}

export function sandboxQuarantineReceiptPath(
  sandboxName: string,
  gatewayPort: number,
  requestIdentity: string,
  home?: string,
): string {
  if (!SHA256_PATTERN.test(requestIdentity)) {
    throw new Error("Invalid quarantine request identity");
  }
  return path.join(
    resolveHostNemoclawDir(gatewayPort, home),
    RECEIPT_DIRECTORY,
    sandboxDirectoryName(sandboxName),
    `${requestIdentity}.json`,
  );
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeReceipt(value: unknown): SandboxQuarantineReceipt {
  if (
    !isObjectRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "sandbox-quarantine-receipt" ||
    (value.status !== "active" &&
      value.status !== "quarantined" &&
      value.status !== "partial" &&
      value.status !== "released") ||
    (value.completedAt !== null && !canonicalTimestamp(value.completedAt)) ||
    (value.releasedAt !== null && !canonicalTimestamp(value.releasedAt))
  ) {
    throw new Error("Sandbox quarantine receipt is malformed");
  }
  const fence = normalizeSandboxQuarantineFence(value.fence);
  if (!fence) throw new Error("Sandbox quarantine receipt has no fence");
  if (value.status === "released" && value.releasedAt === null) {
    throw new Error("Released sandbox quarantine receipt has no release timestamp");
  }
  return {
    schemaVersion: 1,
    kind: "sandbox-quarantine-receipt",
    status: value.status,
    fence,
    completedAt: value.completedAt,
    releasedAt: value.releasedAt,
  };
}

export function readSandboxQuarantineReceipt(filePath: string): SandboxQuarantineReceipt | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) {
    throw new Error("Refusing unsafe sandbox quarantine receipt");
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_RECEIPT_BYTES) {
      throw new Error("Refusing unsafe sandbox quarantine receipt");
    }
    return normalizeReceipt(JSON.parse(fs.readFileSync(fd, "utf8")));
  } finally {
    fs.closeSync(fd);
  }
}

/** Atomically publish and fsync a secret-free quarantine receipt. */
export function writeSandboxQuarantineReceipt(
  filePath: string,
  value: SandboxQuarantineReceipt,
): void {
  const receipt = normalizeReceipt(value);
  writeConfigFile(filePath, receipt);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const directoryFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}
