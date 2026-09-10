#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runHermesAcpCommand } from "./command";

async function main(): Promise<void> {
  const exitCode = await runHermesAcpCommand(process.argv.slice(2), {
    input: process.stdin,
    output: process.stdout,
    diagnostics: process.stderr,
  });
  process.exitCode = exitCode;
}

export const mainPromise = main().catch(() => {
  process.exitCode = 1;
  try {
    process.stderr.write("nemoclaw-acp: command failed.\n");
  } catch {
    // The diagnostic consumer disconnected.
  }
});
