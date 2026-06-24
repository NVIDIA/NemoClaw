// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectAllSlackSocketModeGatewayOverlaps,
  type SlackGatewayOverlap,
} from "../../../applier/conflict-detection/slack-socket-mode";
import type { ConflictRegistryEntry } from "../../../applier/conflict-detection/types";
import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";

export const SLACK_SOCKET_MODE_GATEWAY_STATUS_HOOK_HANDLER_ID = "slack.socketModeGatewayStatus";

export const SLACK_SOCKET_MODE_GATEWAY_STATUS_MESSAGE =
  "'{first}' and '{second}' both have Slack Socket Mode enabled on the same gateway; only one sandbox can receive Slack Socket Mode events unless the gateway supports multiplexing.";

export interface SlackSocketModeGatewayStatusHookOptions {
  readonly registryEntries?:
    | readonly ConflictRegistryEntry[]
    | (() => readonly ConflictRegistryEntry[]);
  readonly detectOverlaps?: (
    entries: readonly ConflictRegistryEntry[],
  ) => readonly SlackGatewayOverlap[];
}

export function createSlackSocketModeGatewayStatusHook(
  options: SlackSocketModeGatewayStatusHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "slack") return {};
    const entries = resolveRegistryEntries(context.inputs?.registryEntries, options);
    if (!entries || entries.length === 0) return {};

    const detectOverlaps = options.detectOverlaps ?? detectAllSlackSocketModeGatewayOverlaps;
    const overlaps = detectOverlaps(entries);
    if (overlaps.length === 0) return {};

    return {
      outputs: {
        gatewayOverlaps: {
          kind: "status",
          value: {
            type: "messaging-overlaps",
            overlaps: overlaps.map(({ gatewayName, sandboxes }) => ({
              channel: "slack",
              gatewayName,
              sandboxes,
              reason: "socket-mode-gateway",
              message: SLACK_SOCKET_MODE_GATEWAY_STATUS_MESSAGE,
            })),
          },
        },
      },
    };
  };
}

export function createSlackSocketModeGatewayStatusHookRegistration(
  options: SlackSocketModeGatewayStatusHookOptions = {},
): MessagingHookRegistration {
  return {
    id: SLACK_SOCKET_MODE_GATEWAY_STATUS_HOOK_HANDLER_ID,
    handler: createSlackSocketModeGatewayStatusHook(options),
  };
}

function resolveRegistryEntries(
  inputEntries: MessagingSerializableValue | undefined,
  options: SlackSocketModeGatewayStatusHookOptions,
): readonly ConflictRegistryEntry[] | null {
  const parsed = parseRegistryEntries(inputEntries);
  if (parsed) return parsed;
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
  return value.flatMap((entry) => {
    if (!isObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
      return [];
    }
    return [
      {
        name: entry.name,
        gatewayName: normalizeNullableString(entry.gatewayName),
        messaging: isObject(entry.messaging)
          ? (entry.messaging as ConflictRegistryEntry["messaging"])
          : null,
      },
    ];
  });
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
