// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { runOpenshell } from "../../adapters/openshell/runtime";
import { ensureLiveSandboxOrExit } from "./gateway-state";

export interface SandboxDownloadOptions {
  sandboxPath: string;
  dest?: string;
}

export interface SandboxDownloadResult {
  sandboxPath: string;
  hostDest: string;
}

export async function downloadFromSandbox(
  sandboxName: string,
  opts: SandboxDownloadOptions,
): Promise<SandboxDownloadResult> {
  if (!opts.sandboxPath || opts.sandboxPath.trim().length === 0) {
    console.error("  No sandbox path provided; refusing to invoke `openshell sandbox download`.");
    process.exit(1);
  }
  const sandboxPath = opts.sandboxPath;
  const hostDest = path.resolve(opts.dest && opts.dest.length > 0 ? opts.dest : ".");
  fs.mkdirSync(hostDest, { recursive: true });

  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });

  runOpenshell(["sandbox", "download", sandboxName, sandboxPath, hostDest]);
  console.error(
    `  Downloaded '${sandboxPath}' from sandbox '${sandboxName}' to '${hostDest}'.`,
  );
  return { sandboxPath, hostDest };
}
