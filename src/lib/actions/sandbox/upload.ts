// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { CLI_NAME } from "../../cli/branding";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { ensureLiveSandboxOrExit } from "./gateway-state";
import { getSandboxTargetGatewayName } from "./gateway-target";
import { resolveHostPathFromCwd } from "./host-path";

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
  const trimmedHostPath = (opts.hostPath ?? "").trim();
  if (!trimmedHostPath) {
    throw new Error(
      `No host path provided; usage: ${CLI_NAME} ${opts.sandboxName} upload <host-path> [sandbox-dest]`,
    );
  }
  // The upload is a host-to-sandbox mutation. An ambient endpoint override can
  // redirect both the liveness check and the upload away from the gateway the
  // registry binds this sandbox to, so reject it before either command runs.
  assertNoOpenShellGatewayEndpointOverride();
  const gatewayName = getSandboxTargetGatewayName(opts.sandboxName);
  const hostPath = resolveHostPathFromCwd(trimmedHostPath);
  const sandboxDest = (opts.sandboxDest ?? "").trim() || "/sandbox/";

  await ensureLiveSandboxOrExit(opts.sandboxName, {
    allowNonReadyPhase: opts.allowNonReadyPhase ?? true,
  });

  runOpenshell(
    ["sandbox", "upload", "-g", gatewayName, "--", opts.sandboxName, hostPath, sandboxDest],
    {
      stdio: "inherit",
    },
  );

  return { hostPath, sandboxDest };
}
