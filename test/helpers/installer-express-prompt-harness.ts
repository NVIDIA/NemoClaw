// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./installer-sourced-env";

export async function runInstallerSourced(body: string, environment: NodeJS.ProcessEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-sourced-"));
  const result = await new Promise<{
    error: Error | undefined;
    status: number | null;
    stderr: string;
    stdout: string;
  }>((resolve) => {
    const child = execFile(
      "bash",
      ["--noprofile", "--norc", "-c", `source "$INSTALLER_UNDER_TEST" >/dev/null\n${body}`],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf-8",
        env: {
          ...environment,
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        },
      },
      (error, stdout, stderr) => {
        const exitCode = error?.code;
        resolve({
          error: error && typeof exitCode !== "number" ? error : undefined,
          status: error ? (typeof exitCode === "number" ? exitCode : child.exitCode) : 0,
          stderr,
          stdout,
        });
      },
    );
    child.stdin?.end();
  });
  return { home, result, output: `${result.stdout}${result.stderr}` };
}
