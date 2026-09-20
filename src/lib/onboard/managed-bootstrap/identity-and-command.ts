// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes as defaultRandomBytes } from "node:crypto";

import {
  MANAGED_STARTUP_EXECUTABLE,
  MANAGED_STARTUP_HOLD_EXECUTABLE,
} from "../managed-startup/hold";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";

export const MANAGED_BOOTSTRAP_IDENTITY_BYTES = 32;
export const MANAGED_BOOTSTRAP_IDENTITY_ENV = "NEMOCLAW_MANAGED_BOOTSTRAP_IDENTITY";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const PROCESS_INJECTION_ENV_KEYS = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "ENV",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PS4",
  "SHELLOPTS",
]);
const PROCESS_INJECTION_ENV_PREFIXES = ["BASH_FUNC_"] as const;

function protocolFail(message: string): never {
  throw new Error(`Managed bootstrap protocol violation: ${message}`);
}

function assertArgv(argv: readonly string[], label: string): void {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > 64 * 1024,
    ) ||
    Buffer.byteLength(JSON.stringify(argv), "utf8") > 128 * 1024
  ) {
    protocolFail(`${label} must be one bounded exact argv`);
  }
}

export function assertManagedBootstrapIdentity(value: string): void {
  if (!SHA256_RE.test(value)) {
    protocolFail("identity must be 32 random bytes encoded as lowercase hex");
  }
}

export function createManagedBootstrapIdentity(
  randomBytes: (size: number) => Buffer = defaultRandomBytes,
): string {
  const identity = randomBytes(MANAGED_BOOTSTRAP_IDENTITY_BYTES).toString("hex");
  assertManagedBootstrapIdentity(identity);
  return identity;
}

export function assertManagedBootstrapSafeProcessEnvironmentKey(key: string): void {
  if (
    PROCESS_INJECTION_ENV_KEYS.has(key) ||
    PROCESS_INJECTION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  ) {
    throw new Error(`Managed bootstrap refuses process-control environment assignment '${key}'.`);
  }
}

export function renderManagedBootstrapHeldCommand(
  request: ManagedStartupRootApplyRequest,
  bootstrapIdentity: string,
  intendedWorkloadArgv: readonly string[],
): readonly string[] {
  assertManagedBootstrapIdentity(bootstrapIdentity);
  assertArgv(intendedWorkloadArgv, "intended workload");
  if (intendedWorkloadArgv[0] !== "env") {
    protocolFail("intended workload must begin with env");
  }
  let executableIndex = 1;
  while (executableIndex < intendedWorkloadArgv.length) {
    const assignment = intendedWorkloadArgv[executableIndex] as string;
    const separator = assignment.indexOf("=");
    if (separator > 0 && assignment.startsWith("BASH_FUNC_")) {
      assertManagedBootstrapSafeProcessEnvironmentKey(assignment.slice(0, separator));
    }
    if (!ENV_ASSIGNMENT_RE.test(assignment)) break;
    assertManagedBootstrapSafeProcessEnvironmentKey(assignment.slice(0, separator));
    executableIndex += 1;
  }
  if (executableIndex >= intendedWorkloadArgv.length) {
    protocolFail("intended workload executable is missing");
  }
  if (intendedWorkloadArgv[executableIndex] !== MANAGED_STARTUP_EXECUTABLE) {
    protocolFail(`intended workload executable must be ${MANAGED_STARTUP_EXECUTABLE}`);
  }
  return Object.freeze([
    ...intendedWorkloadArgv.slice(0, executableIndex),
    MANAGED_STARTUP_HOLD_EXECUTABLE,
    "--agent",
    request.agent,
    "--profile-fingerprint",
    request.profileFingerprint,
    "--bootstrap-identity",
    bootstrapIdentity,
    "--",
    ...intendedWorkloadArgv.slice(executableIndex + 1),
  ]);
}
