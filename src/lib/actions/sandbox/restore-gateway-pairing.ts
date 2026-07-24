// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { verifyRestoredSandboxGatewayPairing } from "../../adapters/openshell/restore-gateway-pairing";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

export type RestoreGatewayPairingDeps = {
  warmupScopeUpgrade: (sandboxName: string) => void;
  autoPairScopeApproval: (sandboxName: string) => void;
  verifyGatewayPairing: (sandboxName: string) => boolean;
};

function defaultRestoreGatewayPairingDeps(): RestoreGatewayPairingDeps {
  const warmup: typeof import("./auto-pair-warmup") = require("./auto-pair-warmup");
  const connect: typeof import("./connect") = require("./connect");
  return {
    warmupScopeUpgrade: warmup.runSandboxScopeWarmupRun,
    autoPairScopeApproval: connect.runConnectAutoPairApprovalPass,
    verifyGatewayPairing: (sandboxName) =>
      verifyRestoredSandboxGatewayPairing(sandboxName, WARMUP_SESSION_ID_PREFIX),
  };
}

export function establishRestoredSandboxGatewayPairing(
  targetSandbox: string,
  deps: RestoreGatewayPairingDeps = defaultRestoreGatewayPairingDeps(),
): void {
  try {
    deps.warmupScopeUpgrade(targetSandbox);
    deps.autoPairScopeApproval(targetSandbox);
    if (!deps.verifyGatewayPairing(targetSandbox)) {
      throw new Error("the authenticated gateway verification run did not succeed");
    }
  } catch (err) {
    throw new Error(
      `could not establish gateway pairing for '${targetSandbox}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
