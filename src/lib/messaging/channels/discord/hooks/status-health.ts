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
  type ChannelStatusHealthHookOptions,
  MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
} from "../../channel-health";
import { HERMES_DISCORD_STATUS_PROBE } from "./hermes-status-probe";
import { cliName } from "../../../../onboard/branding";
import { probeOpenClawDiscordConnection } from "./openclaw-bridge-health";

export const DISCORD_STATUS_HEALTH_HOOK_HANDLER_ID = "discord.statusHealth";

export function createDiscordStatusHealthHook(
  options: ChannelStatusHealthHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    const inputs = context.inputs;
    const agent = inputs?.agent;
    if (
      !inputs ||
      context.channelId !== "discord" ||
      (agent !== "hermes" && agent !== "openclaw")
    ) {
      return {};
    }
    const sandboxName = inputs.currentSandbox;
    let state = "unknown";
    if (
      inputs.channelEnabledInRegistry === true &&
      inputs.presetApplied === true &&
      inputs.presetOnGateway === true &&
      typeof sandboxName === "string" &&
      options.executeSandboxCommand
    ) {
      try {
        const timeoutMs =
          typeof options.timeoutMs === "number" &&
          Number.isFinite(options.timeoutMs) &&
          options.timeoutMs > 0
            ? Math.min(options.timeoutMs, 8_000)
            : 8_000;
        const execute = options.executeSandboxCommand;
        if (agent === "openclaw") {
          state = await probeOpenClawDiscordConnection(
            (command, timeout) => execute(sandboxName, command, timeout),
            timeoutMs,
          );
        } else {
          const result = await execute(
            sandboxName,
            // A quoted heredoc preserves these fixed probe bytes without shell expansion.
            `/opt/hermes/.venv/bin/python - <<'NEMOCLAW_DISCORD_PROBE'\n${HERMES_DISCORD_STATUS_PROBE}\nNEMOCLAW_DISCORD_PROBE`,
            timeoutMs,
          );
          const stdout = typeof result?.stdout === "string" ? result.stdout : "";
          if (
            result?.status === 0 &&
            stdout.length <= 256 &&
            stdout.startsWith("NEMOCLAW_DISCORD_STATUS_V1\n")
          ) {
            const payload: unknown = JSON.parse(
              stdout.slice("NEMOCLAW_DISCORD_STATUS_V1\n".length),
            );
            if (
              typeof payload === "object" &&
              payload !== null &&
              "state" in payload &&
              typeof payload.state === "string"
            )
              state = payload.state;
          }
        }
      } catch {
        /* Failed probes cannot establish authentication. */
      }
    }
    const report = healthReport(inputs, state, agent);
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

export function createDiscordStatusHealthHookRegistration(
  options: ChannelStatusHealthHookOptions = {},
): MessagingHookRegistration {
  return {
    id: DISCORD_STATUS_HEALTH_HOOK_HANDLER_ID,
    handler: createDiscordStatusHealthHook(options),
  };
}

function healthReport(
  inputs: MessagingHookInputMap,
  state: string,
  agent: "hermes" | "openclaw",
): ChannelHealthReport {
  const registered = inputs.channelEnabledInRegistry === true;
  const policy = inputs.presetApplied === true && inputs.presetOnGateway === true;
  const policyStatusUnavailable =
    agent === "openclaw" &&
    registered &&
    inputs.presetApplied === true &&
    inputs.presetOnGateway === null;
  const verdict = !registered
    ? "unconfigured"
    : !policy
      ? policyStatusUnavailable
        ? "unknown"
        : "policy_gap"
      : state === "auth_failed"
        ? "credential_rejected"
        : state === "connected"
          ? "healthy"
          : state === "inactive"
            ? "inactive"
            : state === "blocked"
              ? "blocked"
              : agent === "openclaw" && state === "account_disabled"
                ? "account_disabled"
                : "unknown";
  const agentName = agent === "openclaw" ? "OpenClaw" : "Hermes";
  const detail =
    verdict === "credential_rejected"
      ? `${agentName} reports that Discord rejected the bot token.`
      : verdict === "healthy"
        ? `${agentName} reports a connected Discord adapter.`
        : verdict === "inactive"
          ? `The ${agentName} Discord adapter is not connected.`
          : verdict === "blocked"
            ? `${agentName} reports a blocked Discord gateway.`
            : verdict === "account_disabled"
              ? "The managed Discord account is disabled in OpenClaw."
              : "Discord authentication is unverified; configuration and policy do not establish a connection.";
  const sandbox =
    typeof inputs.currentSandbox === "string" && inputs.currentSandbox
      ? `'${inputs.currentSandbox.replace(/'/g, "'\\''")}'`
      : "<sandbox-name>";
  const command = `${cliName()} ${sandbox}`;
  const hint =
    verdict === "credential_rejected"
      ? `Replace DISCORD_BOT_TOKEN with a bot token from the Discord Developer Portal, then run ${command} channels add discord.`
      : verdict === "healthy"
        ? undefined
        : verdict === "blocked"
          ? `Check Discord application settings and ${agentName} gateway logs, then retry ${command} channels status --channel discord.`
          : verdict === "account_disabled"
            ? `Enable the managed Discord account, then retry ${command} channels status --channel discord --wait.`
            : `Inspect ${agentName} gateway status and logs, then retry ${command} channels status --channel discord.`;
  const report: ChannelHealthReport = {
    schemaVersion: 1,
    channel: "discord",
    agent,
    verdict,
    probedAt: typeof inputs.probedAt === "string" ? inputs.probedAt : "",
    signals: [
      {
        label: "Channel registration",
        severity: registered ? "ok" : "warn",
        detail: registered ? "discord registered" : "discord not registered",
      },
      {
        label: "Policy coverage",
        severity: policy ? "ok" : "warn",
        detail: policy
          ? "discord preset applied"
          : policyStatusUnavailable
            ? "discord preset recorded; gateway policy could not be inspected"
            : "discord policy coverage is missing or unverified",
      },
      {
        label:
          agent === "openclaw" ? "Discord runtime connection" : "Discord runtime authentication",
        severity:
          verdict === "healthy"
            ? "ok"
            : verdict === "credential_rejected" ||
                verdict === "blocked" ||
                verdict === "account_disabled"
              ? "fail"
              : "warn",
        detail,
        ...(hint ? { hint } : {}),
      },
    ],
    hints: hint ? [hint] : [],
  };
  if (agent === "openclaw") {
    report.signals.push({
      label: "Agent responses",
      severity: "info",
      detail: "Not tested. Discord connectivity does not verify model responses.",
    });
    const terminal = [
      "unconfigured",
      "policy_gap",
      "credential_rejected",
      "blocked",
      "account_disabled",
    ].includes(verdict);
    report.readiness = {
      state: verdict === "healthy" ? "ready" : terminal ? "terminal" : "waiting",
      category: policyStatusUnavailable
        ? "network"
        : verdict === "healthy"
          ? null
          : verdict === "credential_rejected"
            ? "credential"
            : verdict === "policy_gap"
              ? "policy"
              : "runtime",
      reason: policyStatusUnavailable ? "policy_status_unavailable" : verdict,
      retryable: !terminal && verdict !== "healthy",
      lastTransitionAt: null,
    };
  }
  return report;
}
