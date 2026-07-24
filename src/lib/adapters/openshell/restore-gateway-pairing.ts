// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";

import { ROOT } from "../../state/paths";
import { resolveOpenshell } from "./resolve";

const RESTORE_GATEWAY_PAIRING_VERIFY_TIMEOUT_MS = 30_000;

const RESTORE_GATEWAY_PAIRING_VERIFY_SCRIPT = `
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
command -v openclaw >/dev/null 2>&1 || exit 1
openclaw agent --agent main --json -m "ping" \
  --session-id "$1restore-verify-$$-$(date +%s)"
`;

// OpenClaw can currently exit zero after using its embedded fallback, and its
// JSON output does not expose a supported, stable transport discriminator.
// These compatibility signals match the gateway-auth live tests. Remove this
// classifier once OpenClaw provides a machine-readable gateway-only result.
const RESTORE_GATEWAY_PAIRING_REJECTION =
  /EMBEDDED FALLBACK|gateway connect failed|scope upgrade pending approval|device pairing required|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded/i;

type RestoreGatewayPairingSpawnResult = {
  status: number | null;
  error?: Error;
  stdout?: string | null;
  stderr?: string | null;
};

export type RestoreGatewayPairingVerifierDeps = {
  resolveOpenshell: () => string | null;
  spawnSync: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
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
        encoding: "utf8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: RESTORE_GATEWAY_PAIRING_VERIFY_TIMEOUT_MS,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    return (
      result.status === 0 &&
      result.error === undefined &&
      !RESTORE_GATEWAY_PAIRING_REJECTION.test(output)
    );
  } catch {
    return false;
  }
}
