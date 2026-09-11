// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function windowsNpmCli(
  root: string,
  executable: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (process.platform !== "win32" || !/^(?:npm|npx)$/.test(executable)) return undefined;
  // Invoke npm's JavaScript entry point directly on Windows, without cmd.exe
  // interpreting paths, environment values, or arguments as shell syntax.
  const npmCli = (env.PATH ?? "")
    .split(path.delimiter)
    .map((directory) =>
      path.resolve(root, directory, "node_modules/npm/bin", `${executable}-cli.js`),
    )
    .find((candidate) => fs.existsSync(candidate));
  if (!npmCli) throw new Error("Could not resolve the installed npm entry point");
  return npmCli;
}

export function executeValidationCommand(
  root: string,
  command: string[],
  env: NodeJS.ProcessEnv,
): number {
  try {
    const executable = command[0];
    const npmCli = windowsNpmCli(root, executable, env);
    const result = spawnSync(
      npmCli ? process.execPath : executable,
      npmCli ? [npmCli, ...command.slice(1)] : command.slice(1),
      { cwd: root, env, stdio: "inherit" },
    );
    if (result.error) console.error(result.error.message);
    return result.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
