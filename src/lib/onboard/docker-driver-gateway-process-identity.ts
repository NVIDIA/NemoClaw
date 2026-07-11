// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { resolveGatewayName } from "./gateway-binding";
import {
  gatewayProcessCmdlineMatches,
  OPENSHELL_GATEWAY_PROCESS_NAMES,
} from "./gateway-process-identity";

type NormalizeGatewayExecutablePath = (value: string | null | undefined) => string | null;

export function readDockerDriverGatewayProcessIdentity(
  pid: number,
  captureProcessArgs: (pid: number) => string,
): string {
  const procCmdlinePath = `/proc/${pid}/cmdline`;
  try {
    if (fs.existsSync(procCmdlinePath)) {
      const identity = fs.readFileSync(procCmdlinePath, "utf-8").replace(/\0/g, " ").trim();
      if (identity) return identity;
    }
  } catch {
    // Fall through to ps on hosts without readable procfs.
  }
  return captureProcessArgs(pid);
}

export function getDockerDriverGatewayTargetIdentityDrift(input: {
  gatewayBin?: string | null;
  gatewayPort: number;
  identity: string;
  normalizeGatewayExecutablePath: NormalizeGatewayExecutablePath;
}): { reason: string } | null {
  const gatewayName = resolveGatewayName(input.gatewayPort);
  const matchesTarget = gatewayProcessCmdlineMatches(input.identity, input.gatewayBin, {
    expectedOpenShellGateway: { name: gatewayName, port: input.gatewayPort },
    processNames: OPENSHELL_GATEWAY_PROCESS_NAMES,
    resolveExecutablePath: input.normalizeGatewayExecutablePath,
  });
  if (matchesTarget) return null;

  // Legacy untagged launches cannot prove which gateway they own. Onboarding
  // treats this drift as a mandatory cutover before reuse; targeted destroy
  // remains fail-closed instead of guessing from a stale PID file.
  return {
    reason: `gateway process lacks target-bound cleanup identity for ${gatewayName} on port ${input.gatewayPort}`,
  };
}
