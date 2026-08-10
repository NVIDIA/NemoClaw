// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelHealthReport,
  ChannelReadiness,
  ChannelReadinessCategory,
  DiagnosticSignal,
} from "../../channel-health";

export type SlackFailureCategory = ChannelReadinessCategory | null;

export type SlackReadinessInput = {
  agent: string;
  probedAt: string;
  lastTransitionAt: string | null;
  channelEnabledInRegistry: boolean;
  presetInRegistry: boolean;
  presetOnGateway: boolean | null;
  probeReachable: boolean;
  pluginConfigured: boolean | null;
  accountPresent: boolean;
  accountEnabled: boolean | null;
  accountConfigured: boolean | null;
  running: boolean | null;
  connected: boolean | null;
  credentialUnavailable: boolean;
  probeOk: boolean | null;
  probeFailureCategory: SlackFailureCategory;
  lastErrorCategory: SlackFailureCategory;
};

export type SlackReadinessReport = ChannelHealthReport & {
  channel: "slack";
  readiness: ChannelReadiness;
};

const HINTS: Record<Exclude<SlackFailureCategory, null>, string> = {
  credential: "replace the rejected Slack credential, then rebuild the sandbox",
  plugin: "rebuild the sandbox and inspect OpenClaw plugin startup logs",
  policy: "restore the slack network policy preset before retrying",
  network: "inspect OpenClaw logs if Socket Mode does not connect before the timeout",
  runtime: "inspect OpenClaw logs if the Slack account does not start before the timeout",
};

export function evaluateSlackReadiness(input: SlackReadinessInput): SlackReadinessReport {
  const readiness = classifySlackReadiness(input);
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
    signals: buildSignals(input),
    hints: readiness.state === "ready" ? [] : [HINTS[readiness.category ?? "runtime"]],
    readiness,
  };
}

function classifySlackReadiness(input: SlackReadinessInput): ChannelReadiness {
  if (!input.channelEnabledInRegistry) return terminal("runtime", "channel_not_registered", input);
  if (!input.presetInRegistry || input.presetOnGateway === false)
    return terminal("policy", "policy_missing", input);
  if (input.presetOnGateway === null) return waiting("network", "policy_status_unavailable", input);
  if (!input.probeReachable) return waiting("network", "status_probe_unreachable", input);
  if (input.pluginConfigured === false) return terminal("plugin", "plugin_not_configured", input);
  if (!input.accountPresent) return waiting("runtime", "account_initializing", input);
  if (input.credentialUnavailable || input.accountConfigured === false)
    return terminal("credential", "credentials_unavailable", input);
  if (input.accountEnabled === false) return terminal("runtime", "account_disabled", input);
  if (input.lastErrorCategory === "credential")
    return terminal("credential", "credential_rejected", input);
  if (input.lastErrorCategory === "plugin") return terminal("plugin", "plugin_failed", input);
  if (input.lastErrorCategory === "runtime") return terminal("runtime", "runtime_failed", input);
  if (input.running !== true) return waiting("runtime", "runtime_starting", input);
  if (input.connected !== true) return waiting("network", "socket_mode_connecting", input);
  if (input.probeOk === false) {
    return input.probeFailureCategory === "credential"
      ? terminal("credential", "credential_probe_failed", input)
      : input.probeFailureCategory === "plugin"
        ? terminal("plugin", "plugin_probe_failed", input)
        : waiting(input.probeFailureCategory ?? "network", "account_probe_retryable", input);
  }
  if (input.probeOk !== true) return waiting("runtime", "account_probe_pending", input);
  return readiness("ready", null, "operational", false, input);
}

function terminal(
  category: Exclude<SlackFailureCategory, null>,
  reason: string,
  input: SlackReadinessInput,
): ChannelReadiness {
  return readiness("terminal", category, reason, false, input);
}

function waiting(
  category: Exclude<SlackFailureCategory, null>,
  reason: string,
  input: SlackReadinessInput,
): ChannelReadiness {
  return readiness("waiting", category, reason, true, input);
}

function readiness(
  state: ChannelReadiness["state"],
  category: SlackFailureCategory,
  reason: string,
  retryable: boolean,
  input: SlackReadinessInput,
): ChannelReadiness {
  return { state, category, reason, retryable, lastTransitionAt: input.lastTransitionAt };
}

function buildSignals(input: SlackReadinessInput): DiagnosticSignal[] {
  const policyMissing = !input.presetInRegistry || input.presetOnGateway === false;
  return [
    {
      label: "Channel registration",
      severity: input.channelEnabledInRegistry ? "ok" : "fail",
      detail: input.channelEnabledInRegistry ? "slack registered" : "slack not registered",
      ...(input.channelEnabledInRegistry
        ? {}
        : { hint: "add the Slack channel before waiting for readiness" }),
    },
    {
      label: "Policy coverage",
      severity: policyMissing ? "fail" : input.presetOnGateway === true ? "ok" : "info",
      detail: !input.presetInRegistry
        ? "slack preset not recorded for the sandbox"
        : input.presetOnGateway === false
          ? "slack preset missing from the OpenShell gateway"
          : input.presetOnGateway === true
            ? "slack preset applied"
            : "slack preset recorded; gateway policy could not be inspected",
    },
    runtimeSignal(input),
    {
      label: "Socket Mode transport",
      severity: input.connected === true ? "ok" : input.connected === false ? "warn" : "info",
      detail:
        input.connected === true
          ? "connected"
          : input.connected === false
            ? "not connected"
            : "connection state not reported",
    },
    probeSignal(input),
  ];
}

function runtimeSignal(input: SlackReadinessInput): DiagnosticSignal {
  if (!input.probeReachable)
    return signal("warn", "OpenClaw channel status is not reachable", "Runtime process");
  if (input.pluginConfigured === false)
    return signal("fail", "OpenClaw does not report a configured Slack plugin", "Runtime process");
  if (!input.accountPresent)
    return signal("warn", "OpenClaw has not published the Slack account yet", "Runtime process");
  if (input.accountEnabled === false)
    return signal("fail", "Slack account is disabled", "Runtime process");
  return signal(
    input.running === true ? "ok" : "warn",
    input.running === true ? "Slack account runtime is running" : "Slack account is starting",
    "Runtime process",
  );
}

function probeSignal(input: SlackReadinessInput): DiagnosticSignal {
  if (input.credentialUnavailable)
    return signal("fail", "Slack credentials are configured but unavailable to OpenClaw");
  if (input.probeOk === true) return signal("ok", "Slack account probe succeeded");
  if (input.probeOk === false)
    return signal(
      input.probeFailureCategory === "credential" ? "fail" : "warn",
      input.probeFailureCategory === "credential"
        ? "Slack rejected the account credential"
        : "Slack account probe did not complete",
    );
  return signal("info", "Slack account probe is pending");
}

function signal(
  severity: DiagnosticSignal["severity"],
  detail: string,
  label = "Account probe",
): DiagnosticSignal {
  return { label, severity, detail };
}
