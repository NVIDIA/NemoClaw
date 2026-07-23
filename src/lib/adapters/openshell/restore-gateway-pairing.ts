// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";

import { ROOT } from "../../state/paths";
import { resolveOpenshell } from "./resolve";

const RESTORE_GATEWAY_PAIRING_VERIFY_TIMEOUT_MS = 30_000;

const RESTORE_GATEWAY_PAIRING_VERIFY_SCRIPT = `
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
command -v openclaw >/dev/null 2>&1 || exit 1
output="$(
  openclaw agent --agent main --json -m "ping" \
    --session-id "$1restore-verify-$$-$(date +%s)" 2>&1
)"
status=$?
[ "$status" -eq 0 ] || exit 1
if printf '%s\n' "$output" | grep -Eiq \
  'EMBEDDED FALLBACK|gateway connect failed|scope upgrade pending approval|device pairing required|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded'; then
  exit 1
fi
exit 0
`;

type RestoreGatewayPairingSpawnResult = {
  status: number | null;
  error?: Error;
};

export type RestoreGatewayPairingVerifierDeps = {
  resolveOpenshell: () => string | null;
  spawnSync: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions,
  ) => RestoreGatewayPairingSpawnResult;
};

const defaultDeps: RestoreGatewayPairingVerifierDeps = {
  resolveOpenshell,
  spawnSync,
};

export function verifyRestoredSandboxGatewayPairing(
  targetSandbox: string,
  sessionIdPrefix: string,
  deps: RestoreGatewayPairingVerifierDeps = defaultDeps,
): boolean {
  try {
    const openshellBinary = deps.resolveOpenshell();
    if (!openshellBinary) return false;

    const result = deps.spawnSync(
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
        "restore-gateway-pairing",
        sessionIdPrefix,
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
