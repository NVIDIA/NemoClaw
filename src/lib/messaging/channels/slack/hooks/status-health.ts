// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookInputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";
import {
  type ChannelHealthReport,
  type ChannelReadiness,
  type ChannelReadinessCategory,
  type ChannelStatusHealthHookOptions,
  DEFAULT_CHANNEL_STATUS_HEALTH_TIMEOUT_MS,
  type DiagnosticSignal,
  MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
} from "../../channel-health";

export const SLACK_STATUS_HEALTH_HOOK_HANDLER_ID = "slack.statusHealth";
const CREDENTIAL_STATUS_KEYS = ["botTokenStatus", "appTokenStatus"] as const;
const HINTS: Record<ChannelReadinessCategory, string> = {
  credential: "replace the rejected Slack credential, then rebuild the sandbox",
  plugin: "rebuild the sandbox and inspect OpenClaw plugin startup logs",
  policy: "restore the slack network policy preset before retrying",
  network: "inspect OpenClaw logs if Socket Mode does not connect before the timeout",
  runtime: "inspect OpenClaw logs if the Slack account does not start before the timeout",
};

export type SlackStatusHealthHookOptions = ChannelStatusHealthHookOptions;

function canRunSlackProbe(inputs: MessagingHookInputMap | undefined): boolean {
  return (
    inputs?.channelEnabledInRegistry === true &&
    inputs.presetApplied === true &&
    inputs.presetOnGateway === true
  );
}

export function createSlackStatusHealthHook(
  options: SlackStatusHealthHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "slack") return {};
    const execute = options.executeSandboxCommand;
    const sandboxName = normalizeString(context.inputs?.currentSandbox);
    if (!execute || !sandboxName) return {};

    const timeoutMs =
      typeof options.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_CHANNEL_STATUS_HEALTH_TIMEOUT_MS;
    const probe = canRunSlackProbe(context.inputs)
      ? runSlackStatusProbe(execute, sandboxName, timeoutMs)
      : UNREACHABLE_PROBE;
    const report = evaluateSlackReadiness(context.inputs, probe);
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
  let payload: unknown;
  try {
    const result = execute(
      sandboxName,
      `openclaw channels status --channel slack --probe --json --timeout ${timeoutMs}`,
      timeoutMs,
    );
    if (!result || result.status !== 0) return UNREACHABLE_PROBE;
    payload = JSON.parse(String(result.stdout ?? ""));
  } catch {
    return UNREACHABLE_PROBE;
  }
  if (!isObjectRecord(payload) || payload.gatewayReachable === false) return UNREACHABLE_PROBE;
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

function evaluateSlackReadiness(
  inputs: MessagingHookInputMap | undefined,
  probe: SlackStatusProbe,
): ChannelHealthReport & { readiness: ChannelReadiness } {
  const canProbe = canRunSlackProbe(inputs);
  const accountProbe = readObject(probe.account?.probe);
  const input = {
    agent: normalizeString(inputs?.agent) ?? "openclaw",
    probedAt: normalizeString(inputs?.probedAt) ?? "",
    lastTransitionAt: probe.lastTransitionAt,
    channelEnabledInRegistry: Boolean(inputs?.channelEnabledInRegistry),
    presetApplied: Boolean(inputs?.presetApplied),
    presetOnGateway: normalizeBoolean(inputs?.presetOnGateway),
    probeReachable: probe.probeReachable,
    pluginConfigured: probe.pluginConfigured,
    accountPresent: probe.account !== null,
    accountEnabled: normalizeBoolean(probe.account?.enabled),
    accountConfigured: normalizeBoolean(probe.account?.configured),
    running: normalizeBoolean(probe.account?.running),
    connected: normalizeBoolean(probe.account?.connected),
    credentialUnavailable: CREDENTIAL_STATUS_KEYS.some(
      (key) => probe.account?.[key] === "configured_unavailable",
    ),
    probeOk: normalizeBoolean(accountProbe?.ok),
    probeFailureCategory: classifyFailure(normalizeString(accountProbe?.error)),
    lastErrorCategory: classifyFailure(normalizeString(probe.account?.lastError)),
  };
  const result = (
    state: ChannelReadiness["state"],
    category: ChannelReadinessCategory | null,
    reason: string,
  ): ChannelReadiness => ({
    state,
    category,
    reason,
    retryable: state === "waiting",
    lastTransitionAt: input.lastTransitionAt,
  });
  const classify = (): ChannelReadiness => {
    if (!input.channelEnabledInRegistry)
      return result("terminal", "runtime", "channel_not_registered");
    if (!input.presetApplied || input.presetOnGateway === false)
      return result("terminal", "policy", "policy_missing");
    if (input.presetOnGateway === null)
      return result("waiting", "network", "policy_status_unavailable");
    if (!input.probeReachable) return result("waiting", "network", "status_probe_unreachable");
    if (input.pluginConfigured === false)
      return result("terminal", "plugin", "plugin_not_configured");
    if (!input.accountPresent) return result("waiting", "runtime", "account_initializing");
    if (input.credentialUnavailable || input.accountConfigured === false)
      return result("terminal", "credential", "credentials_unavailable");
    if (input.accountEnabled === false) return result("terminal", "runtime", "account_disabled");
    if (input.lastErrorCategory === "credential")
      return result("terminal", "credential", "credential_rejected");
    if (input.lastErrorCategory === "plugin") return result("terminal", "plugin", "plugin_failed");
    if (input.lastErrorCategory === "runtime")
      return result("terminal", "runtime", "runtime_failed");
    if (input.running !== true) return result("waiting", "runtime", "runtime_starting");
    if (input.connected !== true) return result("waiting", "network", "socket_mode_connecting");
    if (input.probeOk === false) {
      if (input.probeFailureCategory === "credential")
        return result("terminal", "credential", "credential_probe_failed");
      if (input.probeFailureCategory === "plugin")
        return result("terminal", "plugin", "plugin_probe_failed");
      return result("waiting", input.probeFailureCategory ?? "network", "account_probe_retryable");
    }
    return input.probeOk === true
      ? result("ready", null, "operational")
      : result("waiting", "runtime", "account_probe_pending");
  };
  const runtimeSignal = (): DiagnosticSignal => {
    if (!input.probeReachable)
      return signal("Runtime process", "warn", "OpenClaw channel status is not reachable");
    if (input.pluginConfigured === false)
      return signal(
        "Runtime process",
        "fail",
        "OpenClaw does not report a configured Slack plugin",
      );
    if (!input.accountPresent)
      return signal("Runtime process", "warn", "OpenClaw has not published the Slack account yet");
    if (input.accountEnabled === false)
      return signal("Runtime process", "fail", "Slack account is disabled");
    return signal(
      "Runtime process",
      input.running === true ? "ok" : "warn",
      input.running === true ? "Slack account runtime is running" : "Slack account is starting",
    );
  };
  const probeSignal = (): DiagnosticSignal => {
    if (input.credentialUnavailable)
      return signal(
        "Account probe",
        "fail",
        "Slack credentials are configured but unavailable to OpenClaw",
      );
    if (input.probeOk === true)
      return signal("Account probe", "ok", "Slack account probe succeeded");
    if (input.probeOk === false)
      return signal(
        "Account probe",
        input.probeFailureCategory === "credential" ? "fail" : "warn",
        input.probeFailureCategory === "credential"
          ? "Slack rejected the account credential"
          : "Slack account probe did not complete",
      );
    return signal("Account probe", "info", "Slack account probe is pending");
  };

  const readiness = classify();
  const policyMissing = !input.presetApplied || input.presetOnGateway === false;
  const liveSignals = canProbe
    ? [
        runtimeSignal(),
        signal(
          "Socket Mode transport",
          input.connected === true ? "ok" : input.connected === false ? "warn" : "info",
          input.connected === true
            ? "connected"
            : input.connected === false
              ? "not connected"
              : "connection state not reported",
        ),
        probeSignal(),
      ]
    : [];
  return {
    schemaVersion: 1,
    channel: "slack",
    agent: input.agent,
    verdict:
      readiness.state === "ready"
        ? "healthy"
        : readiness.state === "waiting"
          ? "initializing"
          : (readiness.category ?? "runtime") + "_failure",
    probedAt: input.probedAt,
    signals: [
      signal(
        "Channel registration",
        input.channelEnabledInRegistry ? "ok" : "fail",
        input.channelEnabledInRegistry ? "slack registered" : "slack not registered",
        input.channelEnabledInRegistry
          ? undefined
          : "add the Slack channel before waiting for readiness",
      ),
      signal(
        "Policy coverage",
        policyMissing ? "fail" : input.presetOnGateway === true ? "ok" : "info",
        !input.presetApplied
          ? "slack preset not recorded for the sandbox"
          : input.presetOnGateway === false
            ? "slack preset missing from the OpenShell gateway"
            : input.presetOnGateway === true
              ? "slack preset applied"
              : "slack preset recorded; gateway policy could not be inspected",
      ),
      ...liveSignals,
    ],
    hints: readiness.state === "ready" ? [] : [HINTS[readiness.category ?? "runtime"]],
    readiness,
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
  const latest = new Date(Math.max(...candidates));
  return Number.isNaN(latest.getTime()) ? null : latest.toISOString();
}

function classifyFailure(value: string | null): ChannelReadinessCategory | null {
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

function signal(
  label: string,
  severity: DiagnosticSignal["severity"],
  detail: string,
  hint?: string,
): DiagnosticSignal {
  return { label, severity, detail, ...(hint ? { hint } : {}) };
}
