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
