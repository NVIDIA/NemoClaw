// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactOnboardErrorText, sanitizeOnboardFailure } from "./redaction";

/** Attach sanitized rollback evidence to the original runtime failure. */
export function attachRuntimeRollbackError(failure: Error, rollbackError: unknown): Error {
  const redactedRollbackError = sanitizeOnboardFailure(rollbackError);
  const rollbackDescriptor = Object.getOwnPropertyDescriptor(failure, "runtimeRollbackError");
  if (rollbackDescriptor?.configurable || (!rollbackDescriptor && Object.isExtensible(failure))) {
    Object.defineProperty(failure, "runtimeRollbackError", {
      configurable: true,
      enumerable: true,
      value: redactedRollbackError,
      writable: true,
    });
  } else if (rollbackDescriptor && "value" in rollbackDescriptor && rollbackDescriptor.writable) {
    Object.defineProperty(failure, "runtimeRollbackError", {
      value: redactedRollbackError,
    });
  }
  const detailDescriptor = Object.getOwnPropertyDescriptor(redactedRollbackError, "message");
  const detail =
    detailDescriptor && "value" in detailDescriptor && typeof detailDescriptor.value === "string"
      ? detailDescriptor.value
      : "Rollback failure details were redacted.";
  const messageDescriptor = Object.getOwnPropertyDescriptor(failure, "message");
  const message =
    messageDescriptor && "value" in messageDescriptor && typeof messageDescriptor.value === "string"
      ? redactOnboardErrorText(messageDescriptor.value)
      : "Runtime mutation failed.";
  if (message.includes(detail)) return redactedRollbackError;
  if (
    (!messageDescriptor && !Object.isExtensible(failure)) ||
    (messageDescriptor &&
      !messageDescriptor.configurable &&
      (!("value" in messageDescriptor) || !messageDescriptor.writable))
  ) {
    return redactedRollbackError;
  }
  Object.defineProperty(failure, "message", {
    configurable: messageDescriptor?.configurable ?? true,
    enumerable: messageDescriptor?.enumerable ?? false,
    value: `${message}\nRuntime rollback requires attention: ${detail}`,
    writable: messageDescriptor && "value" in messageDescriptor ? messageDescriptor.writable : true,
  });
  return redactedRollbackError;
}
