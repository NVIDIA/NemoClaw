// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./installer-sourced-env";

export function runInstallerSourced(body: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-sourced-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$INSTALLER_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: path.resolve(import.meta.dirname, "../.."),
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
      },
    },
  );
  return { home, result, output: `${result.stdout}${result.stderr}` };
}
