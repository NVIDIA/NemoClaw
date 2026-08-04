// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import { nemoclawStateRoot } from "../state/state-root";
import { ensureLocalAdapterStateDir } from "./local-adapter-lifecycle";
import { DUAL_STATION_VLLM_API_KEY_FILE } from "./vllm-station-runtime-receipt-path";

export const DUAL_STATION_VLLM_API_KEY_PATTERN = /^[a-f0-9]{64}$/;
// The original managed endpoint key was introduced with dual-Station serving.
// Keep its path stable while exposing topology-neutral names for later managed
// serving profiles.
export const MANAGED_VLLM_API_KEY_FILE = DUAL_STATION_VLLM_API_KEY_FILE;
export const MANAGED_VLLM_API_KEY_PATTERN = DUAL_STATION_VLLM_API_KEY_PATTERN;

export interface DualStationVllmApiKeyOptions {
  stateDir?: string;
  randomBytes?: (size: number) => Buffer;
}

export function managedVllmStateDir(homeDir = os.homedir()): string {
  // The managed vLLM service is host-global rather than gateway-scoped. Every
  // gateway therefore reads the same key even when NEMOCLAW_GATEWAY_PORT is
  // changed for a second sandbox.
  return nemoclawStateRoot(homeDir, DEFAULT_GATEWAY_PORT);
}

export function dualStationVllmApiKeyPath(stateDir = managedVllmStateDir()): string {
  return path.join(stateDir, DUAL_STATION_VLLM_API_KEY_FILE);
}

export const managedVllmApiKeyPath = dualStationVllmApiKeyPath;

function assertPrivateRegularFile(stat: fs.Stats, filePath: string): void {
  if (!stat.isFile()) {
    throw new Error(`Refusing to read managed vLLM API key from non-file path: ${filePath}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Managed vLLM API key file must not be accessible by group or others: ${filePath}`,
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Managed vLLM API key file is not owned by the current user: ${filePath}`);
  }
}

/** Load the host-global managed endpoint key, failing closed on unsafe state. */
export function loadDualStationVllmApiKey(
  options: Pick<DualStationVllmApiKeyOptions, "stateDir"> = {},
): string | null {
  const filePath = dualStationVllmApiKeyPath(options.stateDir ?? managedVllmStateDir());
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Secure no-follow file opens are unavailable on this platform");
  }
  const nonBlock = fs.constants.O_NONBLOCK ?? 0;
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlock);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") {
        throw new Error(
          `Refusing to read managed vLLM API key through a symbolic link: ${filePath}`,
        );
      }
      throw error;
    }
    const opened = fs.fstatSync(fd);
    assertPrivateRegularFile(opened, filePath);
    if (opened.size < 64 || opened.size > 65) {
      throw new Error(`Managed vLLM API key file is malformed: ${filePath}`);
    }
    const value = fs.readFileSync(fd, "utf8").trim();
    if (!DUAL_STATION_VLLM_API_KEY_PATTERN.test(value)) {
      throw new Error(`Managed vLLM API key file is malformed: ${filePath}`);
    }
    return value;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Create the managed endpoint key once, or reuse the existing private key. */
export function ensureDualStationVllmApiKey(options: DualStationVllmApiKeyOptions = {}): string {
  const stateDir = options.stateDir ?? managedVllmStateDir();
  ensureLocalAdapterStateDir(stateDir);
  const existing = loadDualStationVllmApiKey({ stateDir });
  if (existing) return existing;

  const randomBytes = options.randomBytes ?? crypto.randomBytes;
  const value = randomBytes(32).toString("hex");
  if (!DUAL_STATION_VLLM_API_KEY_PATTERN.test(value)) {
    throw new Error("Could not generate a valid managed vLLM API key");
  }

  const filePath = dualStationVllmApiKeyPath(stateDir);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Secure no-follow file opens are unavailable on this platform");
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    const opened = fs.fstatSync(fd);
    assertPrivateRegularFile(opened, filePath);
    fs.writeFileSync(fd, `${value}\n`, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = loadDualStationVllmApiKey({ stateDir });
      if (raced) return raced;
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  const persisted = loadDualStationVllmApiKey({ stateDir });
  if (persisted !== value) {
    throw new Error("Could not verify the persisted managed vLLM API key");
  }
  return value;
}

export const loadManagedVllmApiKey = loadDualStationVllmApiKey;
export const ensureManagedVllmApiKey = ensureDualStationVllmApiKey;
