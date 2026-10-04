// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function gatewayWaitResult(
  result: "ready" | "not-ready" = "ready",
  failures: {
    notReady?: number;
    timeouts?: number;
    errors?: number;
    probeMs?: number;
    sleepMs?: number;
  } = {},
) {
  const defaultNotReady =
    result === "not-ready" &&
    failures.notReady === undefined &&
    failures.timeouts === undefined &&
    failures.errors === undefined
      ? 1
      : 0;
  const notReady = failures.notReady ?? defaultNotReady;
  const timeouts = failures.timeouts ?? 0;
  const errors = failures.errors ?? 0;
  const failureCount = notReady + timeouts + errors;
  const lastFailure =
    errors > 0 ? "error" : timeouts > 0 ? "timeout" : notReady > 0 ? "not-ready" : "none";
  const attempts = failureCount + (result === "ready" ? 1 : 0);
  const probeMs = failures.probeMs ?? 0;
  const sleepMs = failures.sleepMs ?? 0;
  return {
    status: result === "ready" ? 0 : 75,
    stdout: `schema=1 result=${result} attempts=${String(attempts)} notReady=${String(notReady)} timeouts=${String(timeouts)} errors=${String(errors)} lastFailure=${lastFailure} probeMs=${String(probeMs)} sleepMs=${String(sleepMs)}\n`,
  };
}
