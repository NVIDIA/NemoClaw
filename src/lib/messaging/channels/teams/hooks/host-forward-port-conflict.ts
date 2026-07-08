// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getActiveMessagingHostForward } from "../../../host-forward";
import { MessagingHookConflictError } from "../../../hooks/errors";
import type {
  MessagingHookContext,
  MessagingHookHandler,
  MessagingHookRegistration,
} from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";
import { parseSandboxMessagingPlan } from "../../../plan-validation";

export const TEAMS_HOST_FORWARD_PORT_CONFLICT_HOOK_HANDLER_ID = "teams.hostForwardPortConflict";
export const TEAMS_HOST_FORWARD_PORT_STATUS_HOOK_HANDLER_ID = "teams.hostForwardPortStatus";

export const TEAMS_HOST_FORWARD_PORT_STATUS_MESSAGE =
  "'{first}' and '{second}' both use Microsoft Teams webhook port {port}; no two active Teams sandboxes can share that local forward. Set a different MSTEAMS_PORT or stop/remove one sandbox.";

export interface TeamsHostForwardPortConflictRegistryEntry {
  readonly name: string;
  readonly messaging?: { readonly plan?: unknown } | null;
}

export interface TeamsHostForwardPortConflict {
  readonly sandbox: string;
  readonly port: number;
  readonly label: string;
}

export interface TeamsHostForwardPortOverlap {
  readonly port: number;
  readonly sandboxes: [string, string];
}

export interface TeamsHostForwardPortConflictHookOptions {
  readonly currentSandbox?: string | null | (() => string | null);
  readonly registryEntries?:
    | readonly TeamsHostForwardPortConflictRegistryEntry[]
    | (() => readonly TeamsHostForwardPortConflictRegistryEntry[]);
  readonly findConflicts?: (
    currentSandbox: string | null,
    port: number,
    entries: readonly TeamsHostForwardPortConflictRegistryEntry[],
  ) => readonly TeamsHostForwardPortConflict[];
  readonly formatConflict?: (conflict: TeamsHostForwardPortConflict) => string;
}

export interface TeamsHostForwardPortStatusHookOptions {
  readonly registryEntries?:
    | readonly TeamsHostForwardPortConflictRegistryEntry[]
    | (() => readonly TeamsHostForwardPortConflictRegistryEntry[]);
  readonly detectOverlaps?: (
    entries: readonly TeamsHostForwardPortConflictRegistryEntry[],
  ) => readonly TeamsHostForwardPortOverlap[];
}

export function createTeamsHostForwardPortConflictHook(
  options: TeamsHostForwardPortConflictHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "teams") return {};

    const currentSandbox = resolveCurrentSandbox(context, options);
    const port = normalizePort(context.inputs?.webhookPort);
    const entries = resolveRegistryEntries(context, options);
    if (!port || !entries) {
      throw new Error(
        "Microsoft Teams host forward port conflict hook requires webhookPort and registryEntries.",
      );
    }

    const findConflicts = options.findConflicts ?? findTeamsHostForwardPortConflicts;
    const conflicts = findConflicts(currentSandbox, port, entries);
    if (conflicts.length === 0) return {};

    const formatConflict = options.formatConflict ?? formatTeamsHostForwardPortConflictMessage;
    throw new MessagingHookConflictError(conflicts.map(formatConflict).join("\n"));
  };
}

export function createTeamsHostForwardPortStatusHook(
  options: TeamsHostForwardPortStatusHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "teams") return {};
    const entries = resolveRegistryEntries(context, options);
    if (!entries || entries.length === 0) return {};

    const detectOverlaps = options.detectOverlaps ?? detectAllTeamsHostForwardPortOverlaps;
    const overlaps = detectOverlaps(entries);
    if (overlaps.length === 0) return {};

    return {
      outputs: {
        hostForwardPortOverlaps: {
          kind: "status",
          value: {
            type: "messaging-overlaps",
            overlaps: overlaps.map(({ port, sandboxes }) => ({
              channel: "teams",
              port,
              sandboxes,
              reason: "host-forward-port",
              message: TEAMS_HOST_FORWARD_PORT_STATUS_MESSAGE,
            })),
          },
        },
      },
    };
  };
}

export function createTeamsHostForwardPortConflictHookRegistration(
  options: TeamsHostForwardPortConflictHookOptions = {},
): MessagingHookRegistration {
  return {
    id: TEAMS_HOST_FORWARD_PORT_CONFLICT_HOOK_HANDLER_ID,
    handler: createTeamsHostForwardPortConflictHook(options),
  };
}

export function createTeamsHostForwardPortStatusHookRegistration(
  options: TeamsHostForwardPortStatusHookOptions = {},
): MessagingHookRegistration {
  return {
    id: TEAMS_HOST_FORWARD_PORT_STATUS_HOOK_HANDLER_ID,
    handler: createTeamsHostForwardPortStatusHook(options),
  };
}

export function findTeamsHostForwardPortConflicts(
  currentSandbox: string | null,
  port: number,
  entries: readonly TeamsHostForwardPortConflictRegistryEntry[],
): TeamsHostForwardPortConflict[] {
  return entries.flatMap((entry) => {
    if (entry.name === currentSandbox) return [];
    const plan = parseSandboxMessagingPlan(entry.messaging?.plan);
    const forward = getActiveMessagingHostForward(plan);
    if (!forward || forward.port !== port) return [];
    return [
      {
        sandbox: entry.name,
        port: forward.port,
        label: forward.label,
      },
    ];
  });
}

export function detectAllTeamsHostForwardPortOverlaps(
  entries: readonly TeamsHostForwardPortConflictRegistryEntry[],
): TeamsHostForwardPortOverlap[] {
  const byPort = new Map<number, string[]>();
  for (const entry of entries) {
    const plan = parseSandboxMessagingPlan(entry.messaging?.plan);
    const forward = getActiveMessagingHostForward(plan);
    if (!forward || forward.channelId !== "teams") continue;
    const names = byPort.get(forward.port) ?? [];
    names.push(entry.name);
    byPort.set(forward.port, names);
  }

  const overlaps: TeamsHostForwardPortOverlap[] = [];
  for (const [port, names] of byPort) {
    if (names.length < 2) continue;
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        overlaps.push({ port, sandboxes: [names[i], names[j]] });
      }
    }
  }
  return overlaps;
}

export function formatTeamsHostForwardPortConflictMessage({
  sandbox,
  port,
}: TeamsHostForwardPortConflict): string {
  return (
    `Microsoft Teams webhook port ${port} is already forwarded for sandbox '${sandbox}'; ` +
    "choose a different MSTEAMS_PORT or stop/remove the other sandbox before enabling Teams."
  );
}

function resolveCurrentSandbox(
  context: MessagingHookContext,
  options: TeamsHostForwardPortConflictHookOptions,
): string | null {
  return (
    normalizeNullableString(context.inputs?.currentSandbox) ??
    resolveNullableOption(options.currentSandbox)
  );
}

function resolveRegistryEntries(
  context: MessagingHookContext,
  options: TeamsHostForwardPortConflictHookOptions,
): readonly TeamsHostForwardPortConflictRegistryEntry[] | null {
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
): readonly TeamsHostForwardPortConflictRegistryEntry[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!isObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
      return [];
    }
    const messaging = isObject(entry.messaging)
      ? { plan: (entry.messaging as Record<string, unknown>).plan }
      : null;
    return [
      {
        name: entry.name,
        messaging,
      },
    ];
  });
}

function normalizePort(value: unknown): number | null {
  const port = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveNullableOption(
  value: string | null | (() => string | null) | undefined,
): string | null {
  return typeof value === "function" ? value() : (value ?? null);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
