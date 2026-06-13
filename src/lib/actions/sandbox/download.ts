// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { CLI_NAME } from "../../cli/branding";
import { ensureLiveSandboxOrExit } from "./gateway-state";

export interface SandboxDownloadOptions {
  sandboxName: string;
  sandboxPath: string;
  hostDest?: string;
  allowNonReadyPhase?: boolean;
}

export interface SandboxDownloadResult {
  sandboxPath: string;
  hostDest: string;
}

export async function downloadFromSandbox(
  opts: SandboxDownloadOptions,
): Promise<SandboxDownloadResult> {
  const sandboxPath = (opts.sandboxPath ?? "").trim();
  if (!sandboxPath) {
    throw new Error(
      `No sandbox path provided; usage: ${CLI_NAME} ${opts.sandboxName} download <sandbox-path> [host-dest]`,
    );
  }
  const hostDest = (opts.hostDest ?? "").trim() || ".";

  await ensureLiveSandboxOrExit(opts.sandboxName, {
    allowNonReadyPhase: opts.allowNonReadyPhase ?? true,
  });

  runOpenshell(["sandbox", "download", opts.sandboxName, sandboxPath, hostDest], {
    stdio: "inherit",
  });

  return { sandboxPath, hostDest };
}
