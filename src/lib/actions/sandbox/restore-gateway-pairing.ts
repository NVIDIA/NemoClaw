// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { ROOT } from "../../state/paths";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

export const RESTORE_GATEWAY_PAIRING_VERIFY_TIMEOUT_MS = 30_000;

export const RESTORE_GATEWAY_PAIRING_VERIFY_SCRIPT = `
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
command -v openclaw >/dev/null 2>&1 || exit 1
output="$(
  openclaw agent --agent main --json -m "ping" \
    --session-id "${WARMUP_SESSION_ID_PREFIX}restore-verify-$$-$(date +%s)" 2>&1
)"
status=$?
[ "$status" -eq 0 ] || exit 1
if printf '%s\n' "$output" | grep -Eiq \
  'EMBEDDED FALLBACK|gateway connect failed|scope upgrade pending approval|device pairing required|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded'; then
  exit 1
fi
exit 0
`;

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
    verifyGatewayPairing: verifyRestoredSandboxGatewayPairing,
  };
}

export function verifyRestoredSandboxGatewayPairing(targetSandbox: string): boolean {
  const { resolveOpenshell } =
    require("../../adapters/openshell/resolve") as typeof import("../../adapters/openshell/resolve");
  try {
    const openshellBinary = resolveOpenshell();
    if (!openshellBinary) return false;
    const result = spawnSync(
      openshellBinary,
      [
        "sandbox",
        "exec",
        "--name",
        targetSandbox,
        "--",
        "sh",
        "-c",
        RESTORE_GATEWAY_PAIRING_VERIFY_SCRIPT,
      ],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: RESTORE_GATEWAY_PAIRING_VERIFY_TIMEOUT_MS,
      },
    );
    return result.status === 0 && result.error === undefined;
  } catch {
    return false;
  }
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
