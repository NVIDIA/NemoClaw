// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { verifyRestoredSandboxGatewayPairing } from "../../adapters/openshell/restore-gateway-pairing";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

export type RestoreGatewayPairingDeps = {
  restartRestoredSandboxRuntime: (sandboxName: string) => Promise<void>;
  warmupScopeUpgrade: (sandboxName: string) => void;
  autoPairScopeApproval: (sandboxName: string) => void;
  verifyGatewayPairing: (sandboxName: string) => boolean;
};

// A restored clone starts without runtime device credentials. Its first pass
// can approve initial pairing, while strict verification provokes the remaining
// operator.write upgrade. Permit one bounded recovery pass to approve that
// upgrade; never turn pairing establishment into an open-ended retry loop.
const RESTORE_GATEWAY_PAIRING_ATTEMPTS = 2;

type RestoredSandboxRuntimeRestartDeps = {
  stopSandbox: (sandboxName: string) => { exitCode: number; message?: string };
  startSandbox: (sandboxName: string) => Promise<{ exitCode: number; message?: string }>;
};

function defaultRestoredSandboxRuntimeRestartDeps(): RestoredSandboxRuntimeRestartDeps {
  const { stopSandbox }: typeof import("./stop") = require("./stop");
  const { startSandbox }: typeof import("./start") = require("./start");
  return { stopSandbox, startSandbox };
}

export async function restartRestoredSandboxRuntime(
  sandboxName: string,
  deps: RestoredSandboxRuntimeRestartDeps = defaultRestoredSandboxRuntimeRestartDeps(),
): Promise<void> {
  const stopped = deps.stopSandbox(sandboxName);
  if (stopped.exitCode !== 0) {
    throw new Error(stopped.message ?? "could not stop the restored sandbox runtime");
  }
  const started = await deps.startSandbox(sandboxName);
  if (started.exitCode !== 0) {
    throw new Error(started.message ?? "could not restart the restored sandbox runtime");
  }
}

function defaultRestoreGatewayPairingDeps(): RestoreGatewayPairingDeps {
  const warmup: typeof import("./auto-pair-warmup") = require("./auto-pair-warmup");
  const connect: typeof import("./connect") = require("./connect");
  return {
    restartRestoredSandboxRuntime,
    warmupScopeUpgrade: warmup.runSandboxScopeWarmupRun,
    autoPairScopeApproval: connect.runConnectAutoPairApprovalPass,
    verifyGatewayPairing: (sandboxName) =>
      verifyRestoredSandboxGatewayPairing(sandboxName, WARMUP_SESSION_ID_PREFIX),
  };
}

export async function establishRestoredSandboxGatewayPairing(
  targetSandbox: string,
  deps: RestoreGatewayPairingDeps = defaultRestoreGatewayPairingDeps(),
): Promise<void> {
  try {
    // Clone creation starts the agent before the snapshot replaces its runtime
    // state. Restart through the normal lifecycle so the in-sandbox initial
    // pairing watcher observes the restored, credential-free state from boot.
    await deps.restartRestoredSandboxRuntime(targetSandbox);
    for (let attempt = 0; attempt < RESTORE_GATEWAY_PAIRING_ATTEMPTS; attempt += 1) {
      deps.warmupScopeUpgrade(targetSandbox);
      deps.autoPairScopeApproval(targetSandbox);
      if (deps.verifyGatewayPairing(targetSandbox)) {
        return;
      }
    }
    throw new Error("the authenticated gateway verification run did not succeed");
  } catch (err) {
    throw new Error(
      `could not establish gateway pairing for '${targetSandbox}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
