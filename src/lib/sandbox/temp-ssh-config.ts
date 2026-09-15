// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TempSshConfig = {
  dir: string;
  file: string;
  cleanup: () => void;
};

export type TempSshConfigRunResult<T> = Readonly<{
  result: T;
  cleanupError?: TempSshConfigCleanupError;
}>;

type TempSshConfigOperationFailure = Readonly<{ error: unknown }> | undefined;

export class TempSshConfigCleanupError extends Error {
  readonly dir: string;

  constructor(dir: string, cause: unknown) {
    super(
      `NemoClaw failed to remove temporary OpenShell SSH configuration at ${JSON.stringify(dir)}`,
      { cause },
    );
    this.name = "TempSshConfigCleanupError";
    this.dir = dir;
  }
}

export class TempSshConfigOperationCleanupError extends AggregateError {
  readonly operationError: unknown;
  readonly cleanupError: TempSshConfigCleanupError;

  constructor(operationError: unknown, cleanupError: TempSshConfigCleanupError) {
    super(
      [operationError, cleanupError],
      `SSH operation failed and temporary SSH configuration remains at ${JSON.stringify(cleanupError.dir)}`,
    );
    this.name = "TempSshConfigOperationCleanupError";
    this.operationError = operationError;
    this.cleanupError = cleanupError;
  }
}

function finishTempSshConfigRun<T>(
  tempSshConfig: TempSshConfig,
  result: T,
  operationFailure: TempSshConfigOperationFailure,
): TempSshConfigRunResult<T> {
  let cleanupError: TempSshConfigCleanupError | undefined;
  try {
    tempSshConfig.cleanup();
  } catch (error) {
    cleanupError =
      error instanceof TempSshConfigCleanupError
        ? error
        : new TempSshConfigCleanupError(tempSshConfig.dir, error);
  }

  if (operationFailure && cleanupError) {
    throw new TempSshConfigOperationCleanupError(operationFailure.error, cleanupError);
  }
  if (operationFailure) throw operationFailure.error;
  return cleanupError ? { result, cleanupError } : { result };
}

export function runWithTempSshConfigCleanup<T>(
  tempSshConfig: TempSshConfig,
  operation: () => T,
): TempSshConfigRunResult<T> {
  let result!: T;
  let operationFailure: TempSshConfigOperationFailure;
  try {
    result = operation();
  } catch (error) {
    operationFailure = { error };
  }
  return finishTempSshConfigRun(tempSshConfig, result, operationFailure);
}

export async function runWithTempSshConfigCleanupAsync<T>(
  tempSshConfig: TempSshConfig,
  operation: () => Promise<T>,
): Promise<TempSshConfigRunResult<T>> {
  let result!: T;
  let operationFailure: TempSshConfigOperationFailure;
  try {
    result = await operation();
  } catch (error) {
    operationFailure = { error };
  }
  return finishTempSshConfigRun(tempSshConfig, result, operationFailure);
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function createTempSshConfig(contents: string, prefix: string): TempSshConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "ssh_config");
  try {
    fs.writeFileSync(file, contents, { mode: 0o600 });
  } catch (error) {
    try {
      removeTempDir(dir);
    } catch (cleanupError) {
      throw new TempSshConfigCleanupError(
        dir,
        new AggregateError(
          [error, cleanupError],
          "Could not create or remove the temporary SSH configuration",
        ),
      );
    }
    throw error;
  }

  return {
    dir,
    file,
    cleanup: () => {
      try {
        removeTempDir(dir);
      } catch (error) {
        throw new TempSshConfigCleanupError(dir, error);
      }
    },
  };
}
