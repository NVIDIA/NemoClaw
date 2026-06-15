// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MESSAGING_HOOK_CONFLICT_CODE = "MESSAGING_HOOK_CONFLICT";

export class MessagingHookConflictError extends Error {
  readonly code = MESSAGING_HOOK_CONFLICT_CODE;

  constructor(message: string) {
    super(message);
    this.name = "MessagingHookConflictError";
  }
}

export function isMessagingHookConflictError(error: unknown): error is MessagingHookConflictError {
  return (
    error instanceof MessagingHookConflictError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === MESSAGING_HOOK_CONFLICT_CODE)
  );
}
