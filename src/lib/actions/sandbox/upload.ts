// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { CLI_NAME } from "../../cli/branding";
import { ensureLiveSandboxOrExit } from "./gateway-state";

export interface SandboxUploadOptions {
  sandboxName: string;
  hostPath: string;
  sandboxDest?: string;
  allowNonReadyPhase?: boolean;
}

export interface SandboxUploadResult {
  hostPath: string;
  sandboxDest: string;
}

export async function uploadToSandbox(opts: SandboxUploadOptions): Promise<SandboxUploadResult> {
  const hostPath = (opts.hostPath ?? "").trim();
  if (!hostPath) {
    throw new Error(
      `No host path provided; usage: ${CLI_NAME} ${opts.sandboxName} upload <host-path> [sandbox-dest]`,
    );
  }
  const sandboxDest = (opts.sandboxDest ?? "").trim() || "/sandbox/";

  await ensureLiveSandboxOrExit(opts.sandboxName, {
    allowNonReadyPhase: opts.allowNonReadyPhase ?? true,
  });

  runOpenshell(["sandbox", "upload", opts.sandboxName, hostPath, sandboxDest], {
    stdio: "inherit",
  });

  return { hostPath, sandboxDest };
}
