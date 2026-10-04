// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelHookFailureMode, MessagingChannelId } from "../manifest";

export const MESSAGING_HOOK_CONFLICT_CODE = "MESSAGING_HOOK_CONFLICT";

export class MessagingHookConflictError extends Error {
  readonly code = MESSAGING_HOOK_CONFLICT_CODE;
  readonly channelId: MessagingChannelId | undefined;
  readonly onFailure: ChannelHookFailureMode | undefined;

  constructor(
    message: string,
    context: {
      readonly channelId?: MessagingChannelId;
      readonly onFailure?: ChannelHookFailureMode;
    } = {},
  ) {
    super(message);
    this.name = "MessagingHookConflictError";
    this.channelId = context.channelId;
    this.onFailure = context.onFailure;
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
