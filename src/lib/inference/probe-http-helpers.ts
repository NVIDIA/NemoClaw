// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Pure HTTP/curl-probe argument and timing builders extracted from
// onboard-probes.ts. These helpers only compute values from their inputs
// (and the documented NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS override);
// they run no curl and touch no network/process state. Keeping them in a
// focused, typed module lets the probe driver stay small while these builders
// remain independently testable. See PR #6293 PRA-1.

const { isWsl } = require("../platform");

type WslProbeOptions = { isWsl?: boolean } | undefined;

const ONBOARD_VALIDATION_TIMEOUT_ENV = "NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS";

// Per-validation-probe curl timing. Tighter than the default 60s in
// getCurlTimingArgs() because validation must not hang the wizard for a
// minute on a misbehaving model. See issue #1601 (Bug 3).
export function getValidationProbeCurlArgs(opts?: WslProbeOptions): string[] {
  const args = isWsl(opts)
    ? ["--connect-timeout", "20", "--max-time", "30"]
    : ["--connect-timeout", "10", "--max-time", "15"];
  return withValidationMaxTimeOverride(args);
}

export function getDeepSeekV4ProValidationProbeCurlArgs(opts?: WslProbeOptions): string[] {
  const args = isWsl(opts)
    ? ["--connect-timeout", "30", "--max-time", "150"]
    : ["--connect-timeout", "20", "--max-time", "120"];
  return withValidationMaxTimeOverride(args);
}

export function getKimiK26ValidationProbeCurlArgs(opts?: WslProbeOptions): string[] {
  const args = isWsl(opts)
    ? ["--connect-timeout", "20", "--max-time", "90"]
    : ["--connect-timeout", "10", "--max-time", "60"];
  return withValidationMaxTimeOverride(args);
}

export function getExtendedNvidiaEndpointValidationProbeCurlArgs(opts?: WslProbeOptions): string[] {
  const args = isWsl(opts)
    ? ["--connect-timeout", "30", "--max-time", "300"]
    : ["--connect-timeout", "10", "--max-time", "300"];
  return withValidationMaxTimeOverride(args);
}

export function getCurlMaxTimeSeconds(args: readonly string[]): number {
  const maxTimeIndex = args.indexOf("--max-time");
  if (maxTimeIndex === -1) return 30;
  const value = Number(args[maxTimeIndex + 1]);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

export function withValidationMaxTimeOverride(args: string[]): string[] {
  const raw = (process.env[ONBOARD_VALIDATION_TIMEOUT_ENV] || "").trim();
  if (!raw) return args;
  const overrideSeconds = Math.ceil(Number(raw));
  if (!Number.isFinite(overrideSeconds) || overrideSeconds <= 0) return args;
  if (overrideSeconds <= getCurlMaxTimeSeconds(args)) return args;
  const maxTimeIndex = args.indexOf("--max-time");
  if (maxTimeIndex === -1) return args;
  const next = [...args];
  next[maxTimeIndex + 1] = String(overrideSeconds);
  return next;
}

export function getProbeProcessTimeoutMs(args: readonly string[]): number {
  return (getCurlMaxTimeSeconds(args) + 5) * 1000;
}
