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
export const MAX_ONBOARD_VALIDATION_TIMEOUT_SECONDS = 600;
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
  // Calibration samples a cheap endpoint (`GET /models`) and scales that one
  // observation up for the far heavier chat-completions POST. On WSL2 the
  // virtualized network stack makes that scaling optimistic: the sample can
  // return in milliseconds while the POST needs tens of seconds. Keep the
  // floor the uncalibrated branch applies, so calibration can raise a slow
  // host's budget but never lower it below what WSL2 already needs (#10413).
  const wslFloor = isWsl(opts);
  return {
    connectTimeoutSeconds: wslFloor
      ? Math.max(connectTimeoutSeconds, WSL_VALIDATION_TIMING.connectTimeoutSeconds)
      : connectTimeoutSeconds,
    maxTimeSeconds: wslFloor
      ? Math.max(maxTimeSeconds, WSL_VALIDATION_TIMING.maxTimeSeconds)
      : maxTimeSeconds,
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
  return withValidationTimeoutOverride(
    buildCurlTimingArgs(buildValidationProbeTimingProfile(opts)),
  );
}

// The calibrated provider-selection phase has 5 seconds of headroom above its
// p95. Limit the streaming-specific wait to that headroom. The complete probe
// remains subject to the 8-second provider-selection phase budget. See #7792.
export const STREAMING_EVENT_PROBE_MAX_SECONDS = 5;

// Cap the streaming probe's --max-time only (min, never lengthen); connect-timeout
// stays and --max-time bounds the whole call. See #7792.
export function getStreamingEventProbeCurlArgs(opts?: ValidationProbeOptions): string[] {
  const args = buildCurlTimingArgs(buildValidationProbeTimingProfile(opts));
  const maxTimeIndex = args.indexOf("--max-time");
  if (maxTimeIndex === -1) return args;
  const current = Number(args[maxTimeIndex + 1]);
  const capped = Number.isFinite(current)
    ? Math.min(current, STREAMING_EVENT_PROBE_MAX_SECONDS)
    : STREAMING_EVENT_PROBE_MAX_SECONDS;
  const next = [...args];
  next[maxTimeIndex + 1] = String(capped);
  return next;
}

export function getDeepSeekV4ProValidationProbeCurlArgs(opts?: ValidationProbeOptions): string[] {
  const args = isWsl(opts)
    ? ["--connect-timeout", "30", "--max-time", "150"]
    : ["--connect-timeout", "20", "--max-time", "120"];
  return withValidationTimeoutOverride(args);
}

export function getKimiK26ValidationProbeCurlArgs(opts?: ValidationProbeOptions): string[] {
  const args = isWsl(opts)
    ? ["--connect-timeout", "20", "--max-time", "90"]
    : ["--connect-timeout", "10", "--max-time", "60"];
  return withValidationTimeoutOverride(args);
}

export function getExtendedNvidiaEndpointValidationProbeCurlArgs(
  opts?: ValidationProbeOptions,
): string[] {
  const args = isWsl(opts)
    ? ["--connect-timeout", "30", "--max-time", "300"]
    : ["--connect-timeout", "10", "--max-time", "300"];
  return withValidationTimeoutOverride(args);
}

export function getCurlMaxTimeSeconds(args: readonly string[]): number {
  const maxTimeIndex = args.indexOf("--max-time");
  if (maxTimeIndex === -1) return 30;
  const value = Number(args[maxTimeIndex + 1]);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

export function withValidationTimeoutOverride(args: string[]): string[] {
  const raw = (process.env[ONBOARD_VALIDATION_TIMEOUT_ENV] || "").trim();
  if (!raw) return args;
  const requestedSeconds = Math.ceil(Number(raw));
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) return args;
  const overrideSeconds = Math.min(requestedSeconds, MAX_ONBOARD_VALIDATION_TIMEOUT_SECONDS);
  const next = [...args];
  let changed = false;
  for (const flag of ["--connect-timeout", "--max-time"]) {
    const index = args.indexOf(flag);
    if (index === -1) continue;
    const current = Number(args[index + 1]);
    if (Number.isFinite(current) && current > 0 && overrideSeconds <= current) continue;
    next[index + 1] = String(overrideSeconds);
    changed = true;
  }
  return changed ? next : args;
}

export function getProbeProcessTimeoutMs(args: readonly string[]): number {
  return (getCurlMaxTimeSeconds(args) + 5) * 1000;
}
