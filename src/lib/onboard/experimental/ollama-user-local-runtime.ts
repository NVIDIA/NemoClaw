// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { OLLAMA_PORT } from "../../core/ports";
import { ensureConfigDir } from "../../state/config-io";

export { OLLAMA_PORT };

const RECEIPT_DIRECTORY = "ollama";
const RECEIPT_FILE = "user-local-ownership.json";
const MAX_RECEIPT_BYTES = 1024;

interface UserLocalOllamaOwnershipReceipt {
  schemaVersion: 1;
  binPath: string;
}

export interface UserLocalOllamaOwnershipDeps {
  homeDir?: string;
  stateDir?: string;
}

function resolveHomeDir(deps: UserLocalOllamaOwnershipDeps): string {
  return deps.homeDir ?? os.homedir();
}

function resolveStateDir(deps: UserLocalOllamaOwnershipDeps): string {
  return deps.stateDir ?? path.join(resolveHomeDir(deps), ".nemoclaw");
}

function receiptPath(deps: UserLocalOllamaOwnershipDeps): string {
  return path.join(resolveStateDir(deps), RECEIPT_DIRECTORY, RECEIPT_FILE);
}

function expectedBinPath(deps: UserLocalOllamaOwnershipDeps): string {
  return path.join(resolveHomeDir(deps), ".local", "bin", "ollama");
}

function parseReceipt(
  value: unknown,
  deps: UserLocalOllamaOwnershipDeps,
): UserLocalOllamaOwnershipReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("NemoClaw-managed user-local Ollama ownership receipt is malformed");
  }
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join(",") !== "binPath,schemaVersion" ||
    receipt.schemaVersion !== 1 ||
    receipt.binPath !== expectedBinPath(deps)
  ) {
    throw new Error("NemoClaw-managed user-local Ollama ownership receipt is invalid");
  }
  return receipt as unknown as UserLocalOllamaOwnershipReceipt;
}

/** Record the fixed user-local binary only after NemoClaw starts it successfully. */
export function recordUserLocalOllamaOwnership(
  binPath: string,
  deps: UserLocalOllamaOwnershipDeps = {},
): void {
  if (binPath !== expectedBinPath(deps)) {
    throw new Error("NemoClaw refused to record an unexpected user-local Ollama path");
  }
  const target = receiptPath(deps);
  ensureConfigDir(path.dirname(target));
  let file;
  try {
    file = openRegularFileNoFollow(target, { writable: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    file = openRegularFileNoFollow(target, { create: true, mode: 0o600, writable: true });
  }
  try {
    const receipt: UserLocalOllamaOwnershipReceipt = { schemaVersion: 1, binPath };
    file.replaceUtf8(`${JSON.stringify(receipt, null, 2)}\n`, 0o600);
  } finally {
    file.close();
  }
}

/** Load the exact receipt-bound user-local path, or null when no receipt exists. */
export function loadUserLocalOllamaOwnership(
  deps: UserLocalOllamaOwnershipDeps = {},
): string | null {
  let file;
  try {
    file = openRegularFileNoFollow(receiptPath(deps));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const receipt = parseReceipt(JSON.parse(file.readUtf8(MAX_RECEIPT_BYTES)), deps);
    return receipt.binPath;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("NemoClaw-managed user-local Ollama ownership receipt is malformed");
    }
    throw error;
  } finally {
    file.close();
  }
}

/** Remove stale user-local ownership after a successful system installation. */
export function removeUserLocalOllamaOwnership(deps: UserLocalOllamaOwnershipDeps = {}): void {
  try {
    fs.unlinkSync(receiptPath(deps));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export const userLocalOllamaOwnershipInternals = { receiptPath };
