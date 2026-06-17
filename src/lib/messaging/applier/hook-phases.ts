// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookInputMap,
  MessagingHookOutputMap,
  MessagingHookRunResult,
} from "../hooks";
import type {
  ChannelHookPhase,
  MessagingSerializableValue,
  SandboxMessagingPlan,
} from "../manifest";
import { listHookRequests } from "./agent-config";
import type { ConflictRegistryEntry } from "./conflict-detection/types";
import type { MessagingHookApplyRequest, MessagingHookApplyRunner } from "./types";

const EMPTY_OUTPUTS: MessagingHookOutputMap = Object.freeze({});

export interface MessagingHookPhaseOptions {
  readonly runHook?: MessagingHookApplyRunner;
  readonly additionalInputs?: MessagingHookInputMap;
}

export interface MessagingPreEnableHookInputContext {
  readonly currentSandbox?: string | null;
  readonly currentGatewayName?: string | null;
  readonly registryEntries?: readonly ConflictRegistryEntry[];
}

export function createMessagingPreEnableHookInputs(
  context: MessagingPreEnableHookInputContext,
): MessagingHookInputMap {
  const inputs: Record<string, MessagingSerializableValue> = {};
  if (context.currentSandbox !== undefined) {
    inputs.currentSandbox = context.currentSandbox;
  }
  if (context.currentGatewayName !== undefined) {
    inputs.currentGatewayName = context.currentGatewayName;
  }
  if (context.registryEntries) {
    inputs.registryEntries = context.registryEntries.map(serializeRegistryEntry);
  }
  return inputs;
}

export async function applyMessagingHooksForPhase(
  plan: SandboxMessagingPlan,
  phase: ChannelHookPhase,
  options: MessagingHookPhaseOptions = {},
): Promise<{
  readonly phase: ChannelHookPhase;
  readonly hookRequests: readonly MessagingHookApplyRequest[];
  readonly hookResults: readonly MessagingHookRunResult[];
  readonly appliedHooks: readonly string[];
  readonly skippedHooks: readonly string[];
}> {
  const hookRequests = listHookRequests(plan, phase);
  if (hookRequests.length > 0 && !options.runHook) {
    throw new Error(`Messaging hook phase '${phase}' requires a hook runner.`);
  }

  const hookResults: MessagingHookRunResult[] = [];
  const appliedHooks: string[] = [];
  const skippedHooks: string[] = [];
  const skippedChannelIds = new Set<string>();
  for (const request of hookRequests) {
    if (skippedChannelIds.has(request.channelId)) {
      skippedHooks.push(formatHookKey(request));
      continue;
    }
    const requestWithInputs = withAdditionalInputs(request, options.additionalInputs);
    try {
      const result = await options.runHook?.(requestWithInputs);
      appliedHooks.push(formatHookKey(requestWithInputs));
      hookResults.push(normalizeHookRunResult(requestWithInputs, result));
    } catch (error) {
      if (requestWithInputs.onFailure === "skip-channel") {
        skippedChannelIds.add(requestWithInputs.channelId);
        skippedHooks.push(formatHookKey(requestWithInputs));
        continue;
      }
      throw error;
    }
  }

  return {
    phase,
    hookRequests,
    hookResults,
    appliedHooks,
    skippedHooks,
  };
}

export function applyPreEnableChecks(
  plan: SandboxMessagingPlan,
  options?: MessagingHookPhaseOptions,
): ReturnType<typeof applyMessagingHooksForPhase> {
  return applyMessagingHooksForPhase(plan, "pre-enable", options);
}

export function applyHealthChecks(
  plan: SandboxMessagingPlan,
  options?: MessagingHookPhaseOptions,
): ReturnType<typeof applyMessagingHooksForPhase> {
  return applyMessagingHooksForPhase(plan, "health-check", options);
}

export function applyStatusChecks(
  plan: SandboxMessagingPlan,
  options?: MessagingHookPhaseOptions,
): ReturnType<typeof applyMessagingHooksForPhase> {
  return applyMessagingHooksForPhase(plan, "status", options);
}

export function applyDiagnostics(
  plan: SandboxMessagingPlan,
  options?: MessagingHookPhaseOptions,
): ReturnType<typeof applyMessagingHooksForPhase> {
  return applyMessagingHooksForPhase(plan, "diagnostic", options);
}

function normalizeHookRunResult(
  request: MessagingHookApplyRequest,
  result: void | MessagingHookRunResult | { readonly outputs?: MessagingHookOutputMap } | undefined,
): MessagingHookRunResult {
  if (result && "hookId" in result && "handlerId" in result && "phase" in result) {
    return result;
  }
  return {
    hookId: request.hookId,
    handlerId: request.handler,
    phase: request.phase,
    outputs: result?.outputs ?? EMPTY_OUTPUTS,
  };
}

function withAdditionalInputs(
  request: MessagingHookApplyRequest,
  additionalInputs: MessagingHookInputMap | undefined,
): MessagingHookApplyRequest {
  if (!additionalInputs || Object.keys(additionalInputs).length === 0) return request;
  return {
    ...request,
    inputs: {
      ...request.inputs,
      ...additionalInputs,
    },
  };
}

function formatHookKey(request: MessagingHookApplyRequest): string {
  return `${request.channelId}:${request.hookId}`;
}

function serializeRegistryEntry(entry: ConflictRegistryEntry): MessagingSerializableValue {
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
