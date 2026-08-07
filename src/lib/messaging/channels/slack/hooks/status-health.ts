// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";
import {
  type ChannelStatusHealthHookOptions,
  MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
} from "../../channel-health";
import {
  evaluateSlackReadiness,
  type SlackFailureCategory,
  type SlackReadinessInput,
} from "./status-health-eval";

export const SLACK_STATUS_HEALTH_HOOK_HANDLER_ID = "slack.statusHealth";
const DEFAULT_TIMEOUT_MS = 8_000;
const CREDENTIAL_STATUS_KEYS = ["botTokenStatus", "appTokenStatus"] as const;

export type SlackStatusHealthHookOptions = ChannelStatusHealthHookOptions;

export function createSlackStatusHealthHook(
  options: SlackStatusHealthHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "slack") return {};
    const execute = options.executeSandboxCommand;
    const sandboxName = normalizeString(context.inputs?.currentSandbox);
    if (!execute || !sandboxName) return {};

    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const probe = runSlackStatusProbe(execute, sandboxName, timeoutMs);
    const input: SlackReadinessInput = {
      agent: normalizeString(context.inputs?.agent) ?? "openclaw",
      probedAt: normalizeString(context.inputs?.probedAt) ?? "",
      lastTransitionAt: probe.lastTransitionAt,
      channelEnabledInRegistry: Boolean(context.inputs?.channelEnabledInRegistry),
      presetInRegistry: Boolean(context.inputs?.presetInRegistry),
      presetOnGateway: normalizeTristate(context.inputs?.presetOnGateway),
      probeReachable: probe.probeReachable,
      pluginConfigured: probe.pluginConfigured,
      accountPresent: probe.account !== null,
      accountEnabled: normalizeBoolean(probe.account?.enabled),
      accountConfigured: normalizeBoolean(probe.account?.configured),
      running: normalizeBoolean(probe.account?.running),
      connected: normalizeBoolean(probe.account?.connected),
      credentialUnavailable: hasUnavailableCredential(probe.account),
      probeOk: readProbeOk(probe.account),
      probeFailureCategory: classifyFailure(readProbeError(probe.account)),
      lastErrorCategory: classifyFailure(normalizeString(probe.account?.lastError)),
    };
    const report = evaluateSlackReadiness(input);
    return {
      outputs: {
        channelHealth: {
          kind: "status",
          value: {
            type: MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
            report,
          } as unknown as MessagingSerializableValue,
        },
      },
    };
  };
}

export function createSlackStatusHealthHookRegistration(
  options: SlackStatusHealthHookOptions = {},
): MessagingHookRegistration {
  return {
    id: SLACK_STATUS_HEALTH_HOOK_HANDLER_ID,
    handler: createSlackStatusHealthHook(options),
  };
}

type SlackStatusProbe = {
  probeReachable: boolean;
  pluginConfigured: boolean | null;
  account: Record<string, unknown> | null;
  lastTransitionAt: string | null;
};

const UNREACHABLE_PROBE: SlackStatusProbe = {
  probeReachable: false,
  pluginConfigured: null,
  account: null,
  lastTransitionAt: null,
};

function runSlackStatusProbe(
  execute: NonNullable<SlackStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  timeoutMs: number,
): SlackStatusProbe {
  let result: ReturnType<typeof execute>;
  try {
    result = execute(
      sandboxName,
      `openclaw channels status --channel slack --probe --json --timeout ${timeoutMs}`,
      timeoutMs,
    );
  } catch {
    return UNREACHABLE_PROBE;
  }
  if (!result || result.status !== 0) return UNREACHABLE_PROBE;
  const payload = parseJsonObject(String(result.stdout ?? ""));
  if (!payload || payload.gatewayReachable === false) return UNREACHABLE_PROBE;
  const accountsByChannel = readObject(payload.channelAccounts);
  if (!accountsByChannel) return UNREACHABLE_PROBE;
  const accounts = Array.isArray(accountsByChannel.slack)
    ? accountsByChannel.slack.filter(isObjectRecord)
    : [];
  const account =
    accounts.find((candidate) => candidate.accountId === "default") ?? accounts[0] ?? null;
  const channelSummary = readObject(readObject(payload.channels)?.slack);
  return {
    probeReachable: true,
    pluginConfigured: normalizeBoolean(channelSummary?.configured),
    account,
    lastTransitionAt: latestTimestamp(account),
  };
}

function latestTimestamp(account: Record<string, unknown> | null): string | null {
  if (!account) return null;
  const candidates = ["lastStartAt", "lastStopAt", "lastProbeAt"]
    .map((key) => account[key])
    .filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates)).toISOString();
}

function hasUnavailableCredential(account: Record<string, unknown> | null): boolean {
  if (!account) return false;
  return CREDENTIAL_STATUS_KEYS.some((key) => account[key] === "configured_unavailable");
}

function readProbeOk(account: Record<string, unknown> | null): boolean | null {
  const probe = readObject(account?.probe);
  return normalizeBoolean(probe?.ok);
}

function readProbeError(account: Record<string, unknown> | null): string | null {
  const probe = readObject(account?.probe);
  return normalizeString(probe?.error);
}

function classifyFailure(value: string | null): SlackFailureCategory {
  if (!value) return null;
  if (
    /invalid[_ -]?auth|token[_ -]?(?:revoked|expired)|not[_ -]?authed|credential|unauthor/i.test(
      value,
    )
  ) {
    return "credential";
  }
  if (/plugin|module|package|not installed|cannot find/i.test(value)) return "plugin";
  if (/timeout|timed out|network|connect|socket|dns|econn|unreachable/i.test(value)) {
    return "network";
  }
  return "runtime";
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return isObjectRecord(value) ? value : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBoolean(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

function normalizeTristate(value: unknown): boolean | null {
  return normalizeBoolean(value);
}

function normalizeTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MS;
}
