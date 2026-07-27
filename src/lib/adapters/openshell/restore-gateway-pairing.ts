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

export type RestoreGatewayPairingFailureLayer =
  | "openshell-unavailable"
  | "execution-timeout"
  | "spawn-failure"
  | "command-failure"
  | "empty-output"
  | "embedded-fallback"
  | "gateway-connect-failure"
  | "scope-upgrade-pending"
  | "device-pairing-required";

export type RestoreGatewayPairingVerificationResult =
  | { ok: true }
  | { ok: false; failureLayer: RestoreGatewayPairingFailureLayer };

// OpenClaw can currently exit zero after using its embedded fallback, and its
// JSON output does not expose a supported, stable transport discriminator.
// These compatibility signals match the gateway-auth live tests. Keep the
// returned classification fixed and output-free so restore diagnostics never
// expose agent output or credentials. The pinned OpenClaw dependency-review
// gate is the removal checkpoint: reevaluate and remove this classifier when
// OpenClaw provides a supported machine-readable gateway-only result.
const RESTORE_GATEWAY_PAIRING_REJECTIONS: ReadonlyArray<{
  pattern: RegExp;
  failureLayer: RestoreGatewayPairingFailureLayer;
}> = [
  {
    pattern: /scope upgrade pending approval|pairing required: device is asking for more scopes/i,
    failureLayer: "scope-upgrade-pending",
  },
  {
    pattern: /device pairing required|pairing required/i,
    failureLayer: "device-pairing-required",
  },
  {
    pattern: /gateway connect failed/i,
    failureLayer: "gateway-connect-failure",
  },
  {
    pattern: /EMBEDDED FALLBACK|fallbackFrom[": ]+gateway|transport[": ]+embedded/i,
    failureLayer: "embedded-fallback",
  },
];

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
): RestoreGatewayPairingVerificationResult {
  try {
    const openshellBinary = deps.resolveOpenshell();
    if (!openshellBinary) {
      return { ok: false, failureLayer: "openshell-unavailable" };
    }

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
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      return { ok: false, failureLayer: "execution-timeout" };
    }
    if (result.error) {
      return { ok: false, failureLayer: "spawn-failure" };
    }
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const rejection = RESTORE_GATEWAY_PAIRING_REJECTIONS.find(({ pattern }) =>
      pattern.test(output),
    );
    if (rejection) {
      return { ok: false, failureLayer: rejection.failureLayer };
    }
    if (result.status !== 0) {
      return { ok: false, failureLayer: "command-failure" };
    }
    if (!result.stdout?.trim()) {
      return { ok: false, failureLayer: "empty-output" };
    }
    return { ok: true };
  } catch {
    return { ok: false, failureLayer: "spawn-failure" };
  }
}
