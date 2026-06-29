// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  findSlackSocketModeGatewayConflicts,
  formatSlackSocketModeConflictMessage,
  type SlackGatewayConflict,
} from "../../../applier/conflict-detection/slack-socket-mode";
import type { ConflictRegistryEntry } from "../../../applier/conflict-detection/types";
import { MessagingHookConflictError } from "../../../hooks/errors";
import type {
  MessagingHookContext,
  MessagingHookHandler,
  MessagingHookRegistration,
} from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";

export const SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK_HANDLER_ID = "slack.socketModeGatewayConflict";

export interface SlackSocketModeGatewayConflictHookOptions {
  readonly currentSandbox?: string | null | (() => string | null);
  readonly currentGatewayName?: string | (() => string);
  readonly registryEntries?:
    | readonly ConflictRegistryEntry[]
    | (() => readonly ConflictRegistryEntry[]);
  readonly findConflicts?: (
    currentSandbox: string | null,
    currentGatewayName: string,
    entries: readonly ConflictRegistryEntry[],
  ) => readonly SlackGatewayConflict[];
  readonly formatConflict?: (otherSandbox: string) => string;
}

export function createSlackSocketModeGatewayConflictHook(
  options: SlackSocketModeGatewayConflictHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "slack") return {};

    const currentSandbox = resolveCurrentSandbox(context, options);
    const currentGatewayName = resolveCurrentGatewayName(context, options);
    const entries = resolveRegistryEntries(context, options);
    if (!currentGatewayName || !entries) {
      throw new Error(
        "Slack Socket Mode gateway conflict hook requires currentGatewayName and registryEntries.",
      );
    }

    const findConflicts = options.findConflicts ?? findSlackSocketModeGatewayConflicts;
    const conflicts = findConflicts(currentSandbox, currentGatewayName, entries);
    if (conflicts.length === 0) return {};

    const formatConflict = options.formatConflict ?? formatSlackSocketModeConflictMessage;
    throw new MessagingHookConflictError(
      conflicts.map(({ sandbox }) => formatConflict(sandbox)).join("\n"),
    );
  };
}

export function createSlackSocketModeGatewayConflictHookRegistration(
  options: SlackSocketModeGatewayConflictHookOptions = {},
): MessagingHookRegistration {
  return {
    id: SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK_HANDLER_ID,
    handler: createSlackSocketModeGatewayConflictHook(options),
  };
}

function resolveCurrentSandbox(
  context: MessagingHookContext,
  options: SlackSocketModeGatewayConflictHookOptions,
): string | null {
  return (
    normalizeNullableString(context.inputs?.currentSandbox) ??
    resolveNullableOption(options.currentSandbox)
  );
}

function resolveCurrentGatewayName(
  context: MessagingHookContext,
  options: SlackSocketModeGatewayConflictHookOptions,
): string | null {
  return (
    normalizeNullableString(context.inputs?.currentGatewayName) ??
    resolveStringOption(options.currentGatewayName)
  );
}

function resolveRegistryEntries(
  context: MessagingHookContext,
  options: SlackSocketModeGatewayConflictHookOptions,
): readonly ConflictRegistryEntry[] | null {
  const inputEntries = parseRegistryEntries(context.inputs?.registryEntries);
  if (inputEntries) return inputEntries;
  const entries =
    typeof options.registryEntries === "function"
      ? options.registryEntries()
      : options.registryEntries;
  return entries ? [...entries] : null;
}

function parseRegistryEntries(
  value: MessagingSerializableValue | undefined,
): readonly ConflictRegistryEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.flatMap((entry) => {
    if (!isObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
      return [];
    }
    const gatewayName = normalizeNullableString(entry.gatewayName);
    return [
      {
        name: entry.name,
        gatewayName,
        messaging: isObject(entry.messaging)
          ? (entry.messaging as ConflictRegistryEntry["messaging"])
          : null,
      },
    ];
  });
  return entries;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveNullableOption(
  value: string | null | (() => string | null) | undefined,
): string | null {
  return typeof value === "function" ? value() : (value ?? null);
}

function resolveStringOption(value: string | (() => string) | undefined): string | null {
  return typeof value === "function" ? value() : (value ?? null);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
