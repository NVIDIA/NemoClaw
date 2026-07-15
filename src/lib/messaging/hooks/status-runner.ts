// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic runner for `phase: "status"` messaging hooks. Both `nemoclaw status`
 * (bridge-health/overlap outputs) and `nemoclaw <sandbox> channels status`
 * (per-channel runtime-health output) drive channel status probing through this
 * one path, so no channel-specific code lives in either command.
 */

import { isObjectRecord } from "../../core/json-types";
import type * as registry from "../../state/registry";
import { createBuiltInChannelManifestRegistry } from "../channels";
import {
  type ChannelHealthReport,
  MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
} from "../channels/channel-health";
import type { ChannelHookSpec, MessagingAgentId, MessagingSerializableValue } from "../manifest";
import { createBuiltInMessagingHookRegistry } from "./builtins";
import { runMessagingHookSync } from "./hook-runner";

export interface MessagingStatusHookRunOptions {
  readonly agent?: MessagingAgentId;
  readonly agents?: ReadonlySet<MessagingAgentId>;
  readonly channels?: ReadonlySet<string>;
  readonly currentSandbox?: string;
  readonly registryEntries?: readonly registry.SandboxEntry[];
  readonly hookRegistry?: ReturnType<typeof createBuiltInMessagingHookRegistry>;
  /** Extra serializable inputs merged into every status hook's input map. */
  readonly extraInputs?: Readonly<Record<string, MessagingSerializableValue>>;
}

export type MessagingStatusHookRunResult = {
  readonly channelId: string;
  readonly hookId: string;
  readonly outputs: ReturnType<typeof runMessagingHookSync>["outputs"];
};

export function runMessagingStatusHooks(
  options: MessagingStatusHookRunOptions,
): MessagingStatusHookRunResult[] {
  const hookRegistry = options.hookRegistry ?? createBuiltInMessagingHookRegistry();
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const agents: ReadonlySet<MessagingAgentId> = options.agent
    ? new Set<MessagingAgentId>([options.agent])
    : (options.agents ?? new Set<MessagingAgentId>(["openclaw"]));
  const hookResults: MessagingStatusHookRunResult[] = [];
  const seen = new Set<string>();

  for (const agent of agents) {
    for (const manifest of manifestRegistry.listAvailable({ agent })) {
      if (options.channels && !options.channels.has(manifest.id)) continue;
      for (const hook of manifest.hooks) {
        if (!shouldRunStatusHook(hook, agent)) continue;
        const key = `${manifest.id}\0${hook.id}\0${hook.handler}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const result = runMessagingHookSync(hook, hookRegistry, {
            channelId: manifest.id,
            inputs: createMessagingStatusHookInputs(options),
          });
          hookResults.push({
            channelId: manifest.id,
            hookId: hook.id,
            outputs: result.outputs,
          });
        } catch {
          // Status hooks are advisory; a broken hook must not hide the rest of
          // `nemoclaw status` or a channels-status probe.
        }
      }
    }
  }
  return hookResults;
}

function shouldRunStatusHook(hook: ChannelHookSpec, agent: MessagingAgentId): boolean {
  return hook.phase === "status" && (!hook.agents || hook.agents.includes(agent));
}

function createMessagingStatusHookInputs(
  options: MessagingStatusHookRunOptions,
): Record<string, MessagingSerializableValue> {
  const inputs: Record<string, MessagingSerializableValue> = { ...options.extraInputs };
  if (options.currentSandbox) inputs.currentSandbox = options.currentSandbox;
  if (options.registryEntries) {
    inputs.registryEntries = options.registryEntries.map(serializeRegistryEntry);
  }
  return inputs;
}

function serializeRegistryEntry(entry: registry.SandboxEntry): MessagingSerializableValue {
  return {
    name: entry.name,
    gatewayName: entry.gatewayName ?? null,
    messaging: entry.messaging?.plan
      ? {
          plan: entry.messaging.plan as unknown as MessagingSerializableValue,
        }
      : null,
  };
}

/** Extract `messaging-channel-health` reports from status-hook outputs. */
export function readChannelHealthOutputs(
  result: MessagingStatusHookRunResult,
): ChannelHealthReport[] {
  return Object.values(result.outputs).flatMap((output) => {
    if (output.kind !== "status" || !isObjectRecord(output.value)) return [];
    if (output.value.type !== MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE) return [];
    // The runner only validates output kind + JSON-serializability, so
    // field-check the nested report here. A malformed report is dropped (the
    // caller falls back to the basic status report) rather than being cast and
    // crashing the renderer downstream.
    const report = output.value.report;
    return isChannelHealthReport(report) ? [report] : [];
  });
}

function isChannelHealthReport(value: unknown): value is ChannelHealthReport {
  return (
    isObjectRecord(value) &&
    typeof value.channel === "string" &&
    typeof value.agent === "string" &&
    typeof value.verdict === "string" &&
    typeof value.probedAt === "string" &&
    Array.isArray(value.signals) &&
    Array.isArray(value.hints)
  );
}
