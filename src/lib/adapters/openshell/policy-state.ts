// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type OpenShellSandboxError } from "./sandbox-observer";

type JsonObject = Record<string, unknown>;

const POLICY_OBSERVATION_ERROR_CODE = "NEMOCLAW_POLICY_OBSERVATION_ERROR";

/** A final failure while observing or validating live OpenShell policy. */
export class PolicyObservationError extends Error {
  readonly code = POLICY_OBSERVATION_ERROR_CODE;
  readonly policyReadError: OpenShellSandboxError | undefined;

  constructor(
    message: string,
    options?: ErrorOptions & { readonly policyReadError?: OpenShellSandboxError },
  ) {
    super(message, options);
    this.name = "PolicyObservationError";
    this.policyReadError = options?.policyReadError;
  }
}

/** Recognize live-policy observation failures across module boundaries. */
export function isPolicyObservationError(error: unknown): error is PolicyObservationError {
  return (
    error instanceof PolicyObservationError ||
    (isObject(error) &&
      error.code === POLICY_OBSERVATION_ERROR_CODE &&
      typeof error.message === "string")
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
