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

type ValidationProbeCalibration = { ok: true; durationMs: number } | { ok: false; reason?: string };

export type ValidationProbeTimingProfile = {
  connectTimeoutSeconds: number;
  maxTimeSeconds: number;
  observedMs?: number;
  reason?: string;
  source: "standard" | "wsl-fallback" | "calibrated" | "calibration-fallback";
};

type ValidationProbeOptions =
  | {
      isWsl?: boolean;
      validationTiming?: ValidationProbeTimingProfile;
      calibration?: ValidationProbeCalibration;
    }
  | undefined;

const ONBOARD_VALIDATION_TIMEOUT_ENV = "NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS";
const STANDARD_VALIDATION_TIMING: ValidationProbeTimingProfile = {
  connectTimeoutSeconds: 10,
  maxTimeSeconds: 15,
  source: "standard",
};
const WSL_VALIDATION_TIMING: ValidationProbeTimingProfile = {
  connectTimeoutSeconds: 20,
  maxTimeSeconds: 30,
  source: "wsl-fallback",
};
const CALIBRATION_FALLBACK_VALIDATION_TIMING: ValidationProbeTimingProfile = {
  connectTimeoutSeconds: 20,
  maxTimeSeconds: 30,
  source: "calibration-fallback",
};
const CALIBRATED_CONNECT_MIN_SECONDS = 5;
const CALIBRATED_CONNECT_MAX_SECONDS = 30;
const CALIBRATED_MAX_TIME_MIN_SECONDS = STANDARD_VALIDATION_TIMING.maxTimeSeconds;
const CALIBRATED_MAX_TIME_MAX_SECONDS = 60;

function clampSeconds(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.ceil(value)));
}

function copyTimingProfile(profile: ValidationProbeTimingProfile): ValidationProbeTimingProfile {
  return { ...profile };
}

export function buildValidationProbeTimingProfile(
  opts?: ValidationProbeOptions,
): ValidationProbeTimingProfile {
  if (opts?.validationTiming) return copyTimingProfile(opts.validationTiming);
  if (!opts?.calibration) {
    return copyTimingProfile(isWsl(opts) ? WSL_VALIDATION_TIMING : STANDARD_VALIDATION_TIMING);
  }
  if (!opts.calibration.ok) {
    return {
      ...CALIBRATION_FALLBACK_VALIDATION_TIMING,
      reason: opts.calibration.reason,
    };
  }

  const observedSeconds = Math.max(1, Math.ceil(opts.calibration.durationMs / 1000));
  const connectTimeoutSeconds = clampSeconds(
    observedSeconds * 4,
    CALIBRATED_CONNECT_MIN_SECONDS,
    CALIBRATED_CONNECT_MAX_SECONDS,
  );
  const maxTimeSeconds = clampSeconds(
    Math.max(connectTimeoutSeconds + 5, observedSeconds * 6),
    CALIBRATED_MAX_TIME_MIN_SECONDS,
    CALIBRATED_MAX_TIME_MAX_SECONDS,
  );
  return {
    connectTimeoutSeconds,
    maxTimeSeconds,
    observedMs: Math.max(0, Math.round(opts.calibration.durationMs)),
    source: "calibrated",
  };
}

function buildCurlTimingArgs(profile: ValidationProbeTimingProfile): string[] {
  return [
    "--connect-timeout",
    String(profile.connectTimeoutSeconds),
    "--max-time",
    String(profile.maxTimeSeconds),
  ];
}

// Per-validation-probe curl timing. Tighter than the default 60s in
// getCurlTimingArgs() because validation must not hang the wizard for a
// minute on a misbehaving model. See issue #1601 (Bug 3).
export function getValidationProbeCurlArgs(opts?: ValidationProbeOptions): string[] {
  return withValidationMaxTimeOverride(
    buildCurlTimingArgs(buildValidationProbeTimingProfile(opts)),
  );
}

export function getDeepSeekV4ProValidationProbeCurlArgs(opts?: ValidationProbeOptions): string[] {
  const args = isWsl(opts)
    ? ["--connect-timeout", "30", "--max-time", "150"]
    : ["--connect-timeout", "20", "--max-time", "120"];
  return withValidationMaxTimeOverride(args);
}

export function getKimiK26ValidationProbeCurlArgs(opts?: ValidationProbeOptions): string[] {
  const args = isWsl(opts)
    ? ["--connect-timeout", "20", "--max-time", "90"]
    : ["--connect-timeout", "10", "--max-time", "60"];
  return withValidationMaxTimeOverride(args);
}

export function getExtendedNvidiaEndpointValidationProbeCurlArgs(
  opts?: ValidationProbeOptions,
): string[] {
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
