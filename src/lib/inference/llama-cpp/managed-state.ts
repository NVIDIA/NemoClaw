// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type HostLocalInferenceReceipt,
  type HostLocalInferenceReceiptWriter,
  parseHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import {
  ensureLocalAdapterStateDir,
  resolveLocalAdapterStateRoot,
} from "../local-adapter-lifecycle";

export const MANAGED_LLAMA_CPP_STATE_DIRECTORY = "managed-llama-cpp" as const;
export const MANAGED_LLAMA_CPP_API_KEY_FILE = "api-key" as const;
export const MANAGED_LLAMA_CPP_OWNER_FILE = "owner.json" as const;
export const MANAGED_LLAMA_CPP_RECEIPT_FILE = "receipt.json" as const;

const FILE_MODE = 0o600;
const MAX_STATE_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_RECIPE_ID = /^[a-z0-9][a-z0-9._-]{0,159}$/u;

export interface ManagedLlamaCppOwner {
  readonly schemaVersion: 1;
  readonly sandboxName: string;
  readonly catalogDigest: string;
  readonly presetDigest: string;
  readonly recipeDigest: string;
  readonly recipeId: string;
}

export interface ManagedLlamaCppStatePaths {
  readonly root: string;
  readonly stateDir: string;
  readonly apiKeyPath: string;
  readonly ownerPath: string;
  readonly receiptPath: string;
}

export interface ManagedLlamaCppOwnerReservation {
  readonly owner: ManagedLlamaCppOwner;
  readonly created: boolean;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Managed llama.cpp requires current-user filesystem identity.");
  }
  return process.getuid();
}

function normalizeOwner(value: ManagedLlamaCppOwner): ManagedLlamaCppOwner {
  if (
    value?.schemaVersion !== 1 ||
    !SAFE_SANDBOX_NAME.test(value.sandboxName) ||
    !SAFE_RECIPE_ID.test(value.recipeId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.catalogDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.presetDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.recipeDigest) ||
    Object.keys(value).sort().join(",") !==
      "catalogDigest,presetDigest,recipeDigest,recipeId,sandboxName,schemaVersion"
  ) {
    throw new Error("Managed llama.cpp owner state is malformed.");
  }
  return Object.freeze({ ...value });
}

function serializeOwner(value: ManagedLlamaCppOwner): string {
  return `${JSON.stringify(normalizeOwner(value))}\n`;
}

function readPrivateFile(target: string): string | null {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Managed llama.cpp requires no-follow file reads.");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== currentUid() ||
      (before.mode & 0o077) !== 0 ||
      before.size < 1 ||
      before.size > MAX_STATE_BYTES
    ) {
      throw new Error("Managed llama.cpp state is not an owner-only regular file.");
    }
    const value = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Managed llama.cpp state changed during its read.");
    }
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishExclusive(directory: string, target: string, value: string): boolean {
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Managed llama.cpp requires no-follow file writes.");
  }
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
      FILE_MODE,
    );
    fs.writeFileSync(descriptor, value, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    fs.unlinkSync(temporary);
    fsyncDirectory(directory);
    return true;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function requirePrivateDirectory(directory: string): void {
  ensureLocalAdapterStateDir(directory);
  const status = fs.lstatSync(directory);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== currentUid() ||
    (status.mode & 0o077) !== 0 ||
    fs.realpathSync(directory) !== directory
  ) {
    throw new Error("Managed llama.cpp state directory is not private current-user authority.");
  }
}

export function managedLlamaCppStatePaths(
  home: string,
  gatewayPort?: number,
): ManagedLlamaCppStatePaths {
  const root = resolveLocalAdapterStateRoot(home, gatewayPort);
  const stateDir = path.join(root, MANAGED_LLAMA_CPP_STATE_DIRECTORY);
  return Object.freeze({
    root,
    stateDir,
    apiKeyPath: path.join(stateDir, MANAGED_LLAMA_CPP_API_KEY_FILE),
    ownerPath: path.join(stateDir, MANAGED_LLAMA_CPP_OWNER_FILE),
    receiptPath: path.join(stateDir, MANAGED_LLAMA_CPP_RECEIPT_FILE),
  });
}

export function loadManagedLlamaCppOwner(
  paths: ManagedLlamaCppStatePaths,
): ManagedLlamaCppOwner | null {
  requirePrivateDirectory(paths.stateDir);
  const serialized = readPrivateFile(paths.ownerPath);
  if (serialized === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Managed llama.cpp owner state is unreadable.");
  }
  return normalizeOwner(value as ManagedLlamaCppOwner);
}

/** Claim one gateway-scoped managed runtime before any download or engine mutation. */
export function claimManagedLlamaCppOwner(
  paths: ManagedLlamaCppStatePaths,
  ownerValue: ManagedLlamaCppOwner,
): ManagedLlamaCppOwnerReservation {
  requirePrivateDirectory(paths.stateDir);
  const owner = normalizeOwner(ownerValue);
  const expected = serializeOwner(owner);
  const existing = readPrivateFile(paths.ownerPath);
  if (existing !== null) {
    if (existing === expected) return Object.freeze({ owner, created: false });
    const current = loadManagedLlamaCppOwner(paths);
    throw new Error(
      `Managed llama.cpp on this gateway is already reserved by sandbox '${current?.sandboxName ?? "unknown"}'.`,
    );
  }
  if (publishExclusive(paths.stateDir, paths.ownerPath, expected)) {
    return Object.freeze({ owner, created: true });
  }
  const raced = readPrivateFile(paths.ownerPath);
  if (raced === expected) return Object.freeze({ owner, created: false });
  throw new Error("Managed llama.cpp on this gateway was reserved concurrently.");
}

export function reserveManagedLlamaCppOwner(
  paths: ManagedLlamaCppStatePaths,
  ownerValue: ManagedLlamaCppOwner,
): ManagedLlamaCppOwner {
  return claimManagedLlamaCppOwner(paths, ownerValue).owner;
}

export function loadOrCreateManagedLlamaCppApiKey(paths: ManagedLlamaCppStatePaths): string {
  requirePrivateDirectory(paths.stateDir);
  const existing = readPrivateFile(paths.apiKeyPath)?.trim() ?? null;
  if (existing !== null) {
    if (!SHA256.test(existing)) throw new Error("Managed llama.cpp API-key state is malformed.");
    return existing;
  }
  const value = randomBytes(32).toString("hex");
  if (!publishExclusive(paths.stateDir, paths.apiKeyPath, `${value}\n`)) {
    const raced = readPrivateFile(paths.apiKeyPath)?.trim() ?? "";
    if (!SHA256.test(raced)) throw new Error("Managed llama.cpp API-key state is malformed.");
    return raced;
  }
  return value;
}

export function loadManagedLlamaCppApiKey(paths: ManagedLlamaCppStatePaths): string | null {
  requirePrivateDirectory(paths.stateDir);
  const value = readPrivateFile(paths.apiKeyPath)?.trim() ?? null;
  if (value !== null && !SHA256.test(value)) {
    throw new Error("Managed llama.cpp API-key state is malformed.");
  }
  return value;
}

export function loadManagedLlamaCppReceipt(
  paths: ManagedLlamaCppStatePaths,
): HostLocalInferenceReceipt | null {
  requirePrivateDirectory(paths.stateDir);
  const serialized = readPrivateFile(paths.receiptPath);
  return serialized === null ? null : parseHostLocalInferenceReceipt(serialized);
}

export function createManagedLlamaCppReceiptWriter(
  paths: ManagedLlamaCppStatePaths,
  transactionId: string,
): HostLocalInferenceReceiptWriter {
  requirePrivateDirectory(paths.stateDir);
  if (!SHA256.test(transactionId)) {
    throw new Error("Managed llama.cpp receipt transaction identity is malformed.");
  }
  const targetSha256 = createHash("sha256")
    .update("nemoclaw-managed-llama-cpp-receipt/v1")
    .digest("hex");
  return Object.freeze({
    transactionId,
    targetSha256,
    writeExact(serializedReceipt: string) {
      const canonical = `${JSON.stringify(parseHostLocalInferenceReceipt(serializedReceipt))}\n`;
      if (canonical !== serializedReceipt) {
        throw new Error("Managed llama.cpp receipt is not canonical.");
      }
      const existing = readPrivateFile(paths.receiptPath);
      if (existing !== null) {
        if (existing === canonical) return existing;
        throw new Error("Managed llama.cpp receipt target already contains different authority.");
      }
      if (publishExclusive(paths.stateDir, paths.receiptPath, canonical)) return canonical;
      const raced = readPrivateFile(paths.receiptPath);
      if (raced === canonical) return canonical;
      throw new Error("Managed llama.cpp receipt target changed concurrently.");
    },
  });
}
