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

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function createTempSshConfig(contents: string, prefix: string): TempSshConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "ssh_config");
  try {
    fs.writeFileSync(file, contents, { mode: 0o600 });
  } catch (error) {
    removeTempDir(dir);
    throw error;
  }

  return {
    dir,
    file,
    cleanup: () => {
      removeTempDir(dir);
    },
  };
}
