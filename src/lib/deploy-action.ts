// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";

import { getCredential } from "./credentials";
import { executeDeploy } from "./deploy";
import { ROOT, run, runInteractive, shellQuote, validateName } from "./runner";

export async function runDeployAction(instanceName?: string): Promise<void> {
  await executeDeploy({
    instanceName,
    env: process.env,
    rootDir: ROOT,
    getCredential,
    validateName,
    shellQuote,
    run,
    runInteractive,
    execFileSync: (
      file: string,
      args: string[],
      opts: Omit<import("node:child_process").ExecFileSyncOptionsWithStringEncoding, "encoding"> = {},
    ) => String(execFileSync(file, args, { encoding: "utf-8", ...opts })),
    spawnSync,
    log: console.log,
    error: console.error,
    stdoutWrite: (message: string) => process.stdout.write(message),
    exit: (code: number) => process.exit(code),
  });
}
