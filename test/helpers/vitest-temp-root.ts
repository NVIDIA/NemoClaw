// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEEP_TEMP_ENV = "NEMOCLAW_TEST_KEEP_TEMP";
const TEMP_ENV_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;

type TempEnvKey = (typeof TEMP_ENV_KEYS)[number];

function restoreTempEnv(previous: ReadonlyMap<TempEnvKey, string | undefined>): void {
  for (const key of TEMP_ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function setupVitestTempRoot(): () => void {
  const previous = new Map<TempEnvKey, string | undefined>(
    TEMP_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vitest-"));
  const keepTemp = process.env[KEEP_TEMP_ENV] === "1";
  let cleanupComplete = false;

  for (const key of TEMP_ENV_KEYS) process.env[key] = root;

  const cleanup = (): void => {
    if (cleanupComplete) return;
    if (keepTemp) {
      process.stderr.write(`Kept Vitest temp files at ${root}\n`);
    } else {
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
    cleanupComplete = true;
  };

  // Vitest's signal handler can call process.exit() without running global
  // teardown. Keep a synchronous fallback for that path.
  const cleanupOnExit = (): void => {
    try {
      cleanup();
    } catch (error) {
      process.stderr.write(`Failed to remove Vitest temp files at ${root}: ${String(error)}\n`);
      if (!process.exitCode) process.exitCode = 1;
    }
  };

  process.once("exit", cleanupOnExit);

  return () => {
    try {
      cleanup();
      // If removal throws, leave the exit fallback armed to retry after the
      // worker pool closes.
      process.off("exit", cleanupOnExit);
    } finally {
      restoreTempEnv(previous);
    }
  };
}

export default setupVitestTempRoot;
