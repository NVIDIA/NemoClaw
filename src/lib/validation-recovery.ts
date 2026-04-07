// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ValidationFailureLike } from "./onboard-types";
import { compactText } from "./url-utils";
import { classifyValidationFailure, type ValidationClassification } from "./validation";

export interface ProbeRecoveryOptions {
  allowModelRetry?: boolean;
}

export interface ProbeLike {
  failures?: ValidationFailureLike[];
}

export type ProbeRecovery =
  | ValidationClassification
  | {
      kind: "transport";
      retry: "retry";
      failure: ValidationFailureLike;
    };

export function getTransportRecoveryMessage(failure: ValidationFailureLike = {}): string {
  const text = compactText(`${failure.message || ""} ${failure.stderr || ""}`).toLowerCase();
  if (failure.curlStatus === 2 || /option .* is unknown|curl --help|curl --manual/.test(text)) {
    return "  Validation hit a local curl invocation error. Retry after updating NemoClaw or use a different provider temporarily.";
  }
  if (failure.httpStatus === 429) {
    return "  The provider is rate limiting validation requests right now.";
  }
  if (failure.httpStatus && failure.httpStatus >= 500 && failure.httpStatus < 600) {
    return "  The provider endpoint is reachable but currently failing upstream.";
  }
  if (failure.curlStatus === 6 || /could not resolve host|name or service not known/.test(text)) {
    return "  Validation could not resolve the provider hostname. Check DNS, VPN, or the endpoint URL.";
  }
  if (failure.curlStatus === 7 || /connection refused|failed to connect/.test(text)) {
    return "  Validation could not connect to the provider endpoint. Check the URL, proxy, or that the service is up.";
  }
  if (failure.curlStatus === 28 || /timed out|timeout/.test(text)) {
    return "  Validation timed out before the provider replied. Retry, or check network/proxy health.";
  }
  if (
    failure.curlStatus === 35 ||
    failure.curlStatus === 60 ||
    /ssl|tls|certificate/.test(text)
  ) {
    return "  Validation hit a TLS/certificate error. Check HTTPS trust and whether the endpoint URL is correct.";
  }
  if (/proxy/.test(text)) {
    return "  Validation hit a proxy/connectivity error. Check proxy environment settings and endpoint reachability.";
  }
  return "  Validation hit a network or transport error.";
}

export function getProbeRecovery(
  probe: ProbeLike,
  options: ProbeRecoveryOptions = {},
): ProbeRecovery {
  const allowModelRetry = options.allowModelRetry === true;
  const failures = Array.isArray(probe?.failures) ? probe.failures : [];
  if (failures.length === 0) {
    return { kind: "unknown", retry: "selection" };
  }
  if (failures.some((failure) => classifyValidationFailure(failure).kind === "credential")) {
    return { kind: "credential", retry: "credential" };
  }
  const transportFailure = failures.find(
    (failure) => classifyValidationFailure(failure).kind === "transport",
  );
  if (transportFailure) {
    return { kind: "transport", retry: "retry", failure: transportFailure };
  }
  if (allowModelRetry && failures.some((failure) => classifyValidationFailure(failure).kind === "model")) {
    return { kind: "model", retry: "model" };
  }
  if (failures.some((failure) => classifyValidationFailure(failure).kind === "endpoint")) {
    return { kind: "endpoint", retry: "selection" };
  }
  const fallback = classifyValidationFailure(failures[0]);
  if (!allowModelRetry && fallback.kind === "model") {
    return { kind: "unknown", retry: "selection" };
  }
  return fallback;
}
