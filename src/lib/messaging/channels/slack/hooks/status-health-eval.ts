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
          : `${readiness.category ?? "runtime"}_failure`,
    probedAt: input.probedAt,
    signals: buildSignals(input),
    hints: buildHints(readiness),
    readiness,
  };
}

function classifySlackReadiness(input: SlackReadinessInput): ChannelReadiness {
  if (!input.channelEnabledInRegistry) {
    return terminal("runtime", "channel_not_registered", input);
  }
  if (!input.presetInRegistry || input.presetOnGateway === false) {
    return terminal("policy", "policy_missing", input);
  }
  if (input.presetOnGateway === null) {
    return waiting("network", "policy_status_unavailable", input);
  }
  if (!input.probeReachable) {
    return waiting("network", "status_probe_unreachable", input);
  }
  if (input.pluginConfigured === false) {
    return terminal("plugin", "plugin_not_configured", input);
  }
  if (!input.accountPresent) {
    return waiting("runtime", "account_initializing", input);
  }
  if (input.credentialUnavailable || input.accountConfigured === false) {
    return terminal("credential", "credentials_unavailable", input);
  }
  if (input.accountEnabled === false) {
    return terminal("runtime", "account_disabled", input);
  }
  if (input.lastErrorCategory === "credential") {
    return terminal("credential", "credential_rejected", input);
  }
  if (input.lastErrorCategory === "plugin") {
    return terminal("plugin", "plugin_failed", input);
  }
  if (input.lastErrorCategory === "runtime") {
    return terminal("runtime", "runtime_failed", input);
  }
  if (input.running !== true) {
    return waiting("runtime", "runtime_starting", input);
  }
  if (input.connected !== true) {
    return waiting("network", "socket_mode_connecting", input);
  }
  if (input.probeOk === false) {
    return input.probeFailureCategory === "credential"
      ? terminal("credential", "credential_probe_failed", input)
      : waiting(input.probeFailureCategory ?? "network", "account_probe_retryable", input);
  }
  if (input.probeOk !== true) {
    return waiting("runtime", "account_probe_pending", input);
  }
  return {
    state: "ready",
    category: null,
    reason: "operational",
    retryable: false,
    lastTransitionAt: input.lastTransitionAt,
  };
}

function terminal(
  category: Exclude<SlackFailureCategory, null>,
  reason: string,
  input: SlackReadinessInput,
): ChannelReadiness {
  return {
    state: "terminal",
    category,
    reason,
    retryable: false,
    lastTransitionAt: input.lastTransitionAt,
  };
}

function waiting(
  category: Exclude<SlackFailureCategory, null>,
  reason: string,
  input: SlackReadinessInput,
): ChannelReadiness {
  return {
    state: "waiting",
    category,
    reason,
    retryable: true,
    lastTransitionAt: input.lastTransitionAt,
  };
}

function buildSignals(input: SlackReadinessInput): DiagnosticSignal[] {
  return [
    registrationSignal(input),
    policySignal(input),
    runtimeSignal(input),
    transportSignal(input),
    credentialProbeSignal(input),
  ];
}

function registrationSignal(input: SlackReadinessInput): DiagnosticSignal {
  return input.channelEnabledInRegistry
    ? { label: "Channel registration", severity: "ok", detail: "slack registered" }
    : {
        label: "Channel registration",
        severity: "fail",
        detail: "slack not registered",
        hint: "add the Slack channel before waiting for readiness",
      };
}

function policySignal(input: SlackReadinessInput): DiagnosticSignal {
  if (!input.presetInRegistry) {
    return {
      label: "Policy coverage",
      severity: "fail",
      detail: "slack preset not recorded for the sandbox",
    };
  }
  if (input.presetOnGateway === false) {
    return {
      label: "Policy coverage",
      severity: "fail",
      detail: "slack preset missing from the OpenShell gateway",
    };
  }
  return {
    label: "Policy coverage",
    severity: input.presetOnGateway === true ? "ok" : "info",
    detail:
      input.presetOnGateway === true
        ? "slack preset applied"
        : "slack preset recorded; gateway policy could not be inspected",
  };
}

function runtimeSignal(input: SlackReadinessInput): DiagnosticSignal {
  if (!input.probeReachable) {
    return {
      label: "Runtime process",
      severity: "warn",
      detail: "OpenClaw channel status is not reachable",
    };
  }
  if (input.pluginConfigured === false) {
    return {
      label: "Runtime process",
      severity: "fail",
      detail: "OpenClaw does not report a configured Slack plugin",
    };
  }
  if (!input.accountPresent) {
    return {
      label: "Runtime process",
      severity: "warn",
      detail: "OpenClaw has not published the Slack account yet",
    };
  }
  if (input.accountEnabled === false) {
    return { label: "Runtime process", severity: "fail", detail: "Slack account is disabled" };
  }
  return {
    label: "Runtime process",
    severity: input.running === true ? "ok" : "warn",
    detail:
      input.running === true ? "Slack account runtime is running" : "Slack account is starting",
  };
}

function transportSignal(input: SlackReadinessInput): DiagnosticSignal {
  return {
    label: "Socket Mode transport",
    severity: input.connected === true ? "ok" : input.connected === false ? "warn" : "info",
    detail:
      input.connected === true
        ? "connected"
        : input.connected === false
          ? "not connected"
          : "connection state not reported",
  };
}

function credentialProbeSignal(input: SlackReadinessInput): DiagnosticSignal {
  if (input.credentialUnavailable) {
    return {
      label: "Account probe",
      severity: "fail",
      detail: "Slack credentials are configured but unavailable to OpenClaw",
    };
  }
  if (input.probeOk === true) {
    return { label: "Account probe", severity: "ok", detail: "Slack account probe succeeded" };
  }
  if (input.probeOk === false) {
    return {
      label: "Account probe",
      severity: input.probeFailureCategory === "credential" ? "fail" : "warn",
      detail:
        input.probeFailureCategory === "credential"
          ? "Slack rejected the account credential"
          : "Slack account probe did not complete",
    };
  }
  return { label: "Account probe", severity: "info", detail: "Slack account probe is pending" };
}

function buildHints(readiness: ChannelReadiness): string[] {
  if (readiness.state === "ready") return [];
  switch (readiness.category) {
    case "credential":
      return ["replace the rejected Slack credential, then rebuild the sandbox"];
    case "plugin":
      return ["rebuild the sandbox and inspect OpenClaw plugin startup logs"];
    case "policy":
      return ["restore the slack network policy preset before retrying"];
    case "network":
      return ["inspect OpenClaw logs if Socket Mode does not connect before the timeout"];
    case "runtime":
    default:
      return ["inspect OpenClaw logs if the Slack account does not start before the timeout"];
  }
}
