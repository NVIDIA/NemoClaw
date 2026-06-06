// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelHookOutputSpec,
  ChannelHookPhase,
  MessagingChannelId,
  MessagingSerializableValue,
} from "../manifest";

/** Stable hook handler identifier referenced from a channel manifest. */
export type MessagingHookHandlerId = string;

/** Serializable input values passed to a hook handler at execution time. */
export type MessagingHookInputMap = Readonly<Record<string, MessagingSerializableValue>>;

/** Minimal runner context needed to execute one hook for one channel. */
export interface MessagingHookRunContext {
  readonly channelId: MessagingChannelId;
  readonly isInteractive?: boolean;
  readonly inputs?: MessagingHookInputMap;
}

/** Context visible to a registered hook handler. */
export interface MessagingHookContext extends MessagingHookRunContext {
  readonly hookId: string;
  readonly phase: ChannelHookPhase;
  readonly outputDeclarations?: readonly ChannelHookOutputSpec[];
}

/** One named output emitted by a hook handler. */
export interface MessagingHookOutputValue {
  readonly kind: ChannelHookOutputSpec["kind"];
  readonly value: MessagingSerializableValue;
}

/** Hook outputs keyed by the ids declared in the manifest hook spec. */
export type MessagingHookOutputMap = Readonly<Record<string, MessagingHookOutputValue>>;

/** Serializable data returned by a hook handler after any side effects complete. */
export interface MessagingHookResult {
  readonly outputs?: MessagingHookOutputMap;
}

/** Function registered under a stable hook handler id. */
export type MessagingHookHandler = (
  context: MessagingHookContext,
) => MessagingHookResult | Promise<MessagingHookResult>;

/** Constructor entry used to seed a hook registry in tests or later bootstraps. */
export interface MessagingHookRegistration {
  readonly id: MessagingHookHandlerId;
  readonly handler: MessagingHookHandler;
}

/** Serializable runner result for a completed hook. */
export interface MessagingHookRunResult {
  readonly hookId: string;
  readonly handlerId: MessagingHookHandlerId;
  readonly phase: ChannelHookPhase;
  readonly outputs: MessagingHookOutputMap;
}
