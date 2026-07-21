// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared shapes for channel runtime-health status hooks.
 *
 * A channel that can be probed at `channels status` time declares a
 * `phase: "status"` hook whose handler returns a `messaging-channel-health`
 * status output carrying a {@link ChannelHealthReport}. The generic status
 * command renders that report without importing any per-channel code, so
 * channel-specific probing/classification stays inside the channel folder.
 */

import type { MessagingSerializableValue } from "../manifest";

export type DiagnosticSeverity = "ok" | "warn" | "fail" | "info";

export type DiagnosticSignal = {
  label: string;
  severity: DiagnosticSeverity;
  detail: string;
  hint?: string;
};

/**
 * Structured runtime-health verdict a status hook emits. `verdict` is a plain
 * string so the generic renderer stays channel-agnostic; each channel narrows
 * it to its own union internally.
 */
export type ChannelHealthReport = {
  schemaVersion: 1;
  channel: string;
  agent: string;
  verdict: string;
  probedAt: string;
  signals: DiagnosticSignal[];
  hints: string[];
};

/** `kind: "status"` output `value.type` carrying a {@link ChannelHealthReport}. */
export const MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE = "messaging-channel-health";

export interface ChannelHealthCommandResult {
  readonly status?: number | null;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

/** Runs one command inside a named sandbox; used by channel-health status hooks. */
export type ChannelHealthCommandRunner = (
  sandboxName: string,
  command: string,
  timeoutMs: number,
) => ChannelHealthCommandResult | null | undefined;

/**
 * Options a channel-health status hook accepts. `executeSandboxCommand` is a
 * host capability threaded once (top-level) into every channel's health hook —
 * the way `openclawBridgeHealth` is threaded — so the generic status command
 * never names a specific channel to enable probing.
 */
export interface ChannelStatusHealthHookOptions {
  readonly executeSandboxCommand?: ChannelHealthCommandRunner;
  readonly timeoutMs?: number;
}

/**
 * Host-side facts the generic status command computes per channel and passes as
 * status-hook inputs. Generic — a channel-health probe hook reads these keys
 * rather than the orchestrator embedding channel-specific probing.
 */
export interface ChannelHealthProbeFacts {
  readonly currentSandbox: string;
  readonly agent: string;
  readonly probedAt: string;
  readonly channelEnabledInRegistry: boolean;
  readonly presetInRegistry: boolean;
  readonly presetOnGateway: boolean | null;
}

/** Serializable status-hook input map built from {@link ChannelHealthProbeFacts}. */
export function channelHealthProbeInputs(
  facts: ChannelHealthProbeFacts,
): Record<string, MessagingSerializableValue> {
  return {
    currentSandbox: facts.currentSandbox,
    agent: facts.agent,
    probedAt: facts.probedAt,
    channelEnabledInRegistry: facts.channelEnabledInRegistry,
    presetInRegistry: facts.presetInRegistry,
    presetOnGateway: facts.presetOnGateway,
  };
}
