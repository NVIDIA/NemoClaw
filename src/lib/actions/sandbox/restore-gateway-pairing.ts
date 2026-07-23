// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type RestoreGatewayPairingDeps = {
  warmupScopeUpgrade: (sandboxName: string) => void;
  autoPairScopeApproval: (sandboxName: string) => void;
};

function defaultRestoreGatewayPairingDeps(): RestoreGatewayPairingDeps {
  const warmup: typeof import("./auto-pair-warmup") = require("./auto-pair-warmup");
  const connect: typeof import("./connect") = require("./connect");
  return {
    warmupScopeUpgrade: warmup.runSandboxScopeWarmupRun,
    autoPairScopeApproval: connect.runConnectAutoPairApprovalPass,
  };
}

export function establishRestoredSandboxGatewayPairing(
  targetSandbox: string,
  deps: RestoreGatewayPairingDeps = defaultRestoreGatewayPairingDeps(),
): void {
  try {
    deps.warmupScopeUpgrade(targetSandbox);
    deps.autoPairScopeApproval(targetSandbox);
  } catch (err) {
    console.warn(
      `  Warning: could not establish gateway pairing for '${targetSandbox}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
