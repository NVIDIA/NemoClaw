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

export const DISCORD_STATUS_HEALTH_HOOK_HANDLER_ID = "discord.statusHealth";

export function createDiscordStatusHealthHook(
  options: ChannelStatusHealthHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    if (context.channelId !== "discord" || context.inputs?.agent !== "hermes") return {};
    const inputs = context.inputs;
    let state = "unknown";
    if (
      inputs.channelEnabledInRegistry === true &&
      inputs.presetApplied === true &&
      inputs.presetOnGateway === true &&
      typeof inputs.currentSandbox === "string" &&
      options.executeSandboxCommand
    ) {
      try {
        const timeoutMs =
          typeof options.timeoutMs === "number" &&
          Number.isFinite(options.timeoutMs) &&
          options.timeoutMs > 0
            ? Math.min(options.timeoutMs, 8_000)
            : 8_000;
        const result = await options.executeSandboxCommand(
          inputs.currentSandbox,
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
          const payload: unknown = JSON.parse(stdout.slice("NEMOCLAW_DISCORD_STATUS_V1\n".length));
          if (
            typeof payload === "object" &&
            payload !== null &&
            "state" in payload &&
            typeof payload.state === "string"
          )
            state = payload.state;
        }
      } catch {
        /* Failed probes cannot establish authentication. */
      }
    }
    const report = healthReport(inputs, state);
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

function healthReport(inputs: MessagingHookInputMap, state: string): ChannelHealthReport {
  const registered = inputs.channelEnabledInRegistry === true;
  const policy = inputs.presetApplied === true && inputs.presetOnGateway === true;
  const verdict = !registered
    ? "unconfigured"
    : !policy
      ? "policy_gap"
      : state === "auth_failed"
        ? "credential_rejected"
        : state === "connected"
          ? "healthy"
          : state === "inactive"
            ? "inactive"
            : "unknown";
  const detail =
    verdict === "credential_rejected"
      ? "Hermes reports that Discord rejected the bot token."
      : verdict === "healthy"
        ? "Hermes reports a connected Discord adapter."
        : verdict === "inactive"
          ? "The Hermes Discord adapter is not connected."
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
        : `Inspect Hermes gateway status and logs, then retry ${command} channels status --channel discord.`;
  return {
    schemaVersion: 1,
    channel: "discord",
    agent: "hermes",
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
          : "discord policy coverage is missing or unverified",
      },
      {
        label: "Discord runtime authentication",
        severity:
          verdict === "healthy" ? "ok" : verdict === "credential_rejected" ? "fail" : "warn",
        detail,
        ...(hint ? { hint } : {}),
      },
    ],
    hints: hint ? [hint] : [],
  };
}
