// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../../../core/shell-quote";
import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";
import {
  type ChannelHealthReport,
  type ChannelStatusHealthHookOptions,
  type DiagnosticSignal,
  MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
} from "../../channel-health";

export const VOICECLAW_STATUS_HEALTH_HOOK_HANDLER_ID = "voiceclaw.statusHealth";
const DEFAULT_TIMEOUT_MS = 8_000;
const PLUGIN_PRESENT_MARKER = "NEMOCLAW_VOICECLAW_PLUGIN_PRESENT";
const PLUGIN_MISSING_MARKER = "NEMOCLAW_VOICECLAW_PLUGIN_MISSING";

export type VoiceClawStatusHealthHookOptions = ChannelStatusHealthHookOptions;

type VoiceClawProbe = {
  readonly configReadable: boolean;
  readonly pluginEnabled: boolean;
  readonly voiceModeEnabled: boolean;
  readonly bridgeConfigured: boolean;
  readonly bridgeReachable: boolean;
};

export function createVoiceClawStatusHealthHook(
  options: VoiceClawStatusHealthHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "voiceclaw") return {};
    const execute = options.executeSandboxCommand;
    const sandboxName = normalizeString(context.inputs?.currentSandbox);
    const agent = normalizeString(context.inputs?.agent) ?? "openclaw";
    if (!execute || !sandboxName || agent !== "openclaw") return {};

    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    let result: ReturnType<typeof execute>;
    try {
      result = execute(sandboxName, buildVoiceClawProbeScript(), timeoutMs);
    } catch {
      result = null;
    }
    const probe = result?.status === 0 ? parseProbe(String(result.stdout ?? "")) : null;
    const pluginPresent = String(result?.stdout ?? "")
      .split(/\r?\n/)
      .includes(PLUGIN_PRESENT_MARKER);
    const report = evaluateVoiceClawHealth({
      agent,
      probe,
      pluginPresent,
      probedAt: normalizeString(context.inputs?.probedAt) ?? "",
      channelEnabledInRegistry: Boolean(context.inputs?.channelEnabledInRegistry),
      presetInRegistry: Boolean(context.inputs?.presetInRegistry),
      presetOnGateway: normalizeTristate(context.inputs?.presetOnGateway),
    });

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

export function createVoiceClawStatusHealthHookRegistration(
  options: VoiceClawStatusHealthHookOptions = {},
): MessagingHookRegistration {
  return {
    id: VOICECLAW_STATUS_HEALTH_HOOK_HANDLER_ID,
    handler: createVoiceClawStatusHealthHook(options),
  };
}

function buildVoiceClawProbeScript(): string {
  const nodeScript = String.raw`
const fs = require("fs");
(async () => {
const result = {
  configReadable: false,
  pluginEnabled: false,
  voiceModeEnabled: false,
  bridgeConfigured: false,
  bridgeReachable: false,
};
try {
  const config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
  result.configReadable = true;
  const plugin = config?.plugins?.entries?.voiceclaw;
  result.pluginEnabled = plugin?.enabled === true;
  result.voiceModeEnabled = plugin?.config?.voiceModeEnabled === true;
  const bridgeUrl = plugin?.config?.audioBridgeUrl;
  if (typeof bridgeUrl === "string" && bridgeUrl.trim()) {
    const url = new URL("/health", bridgeUrl);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) {
      result.bridgeConfigured = true;
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      result.bridgeReachable = response.ok;
    }
  }
} catch {}
process.stdout.write(JSON.stringify(result) + "\n");
})().catch(() => process.stdout.write("{}\n"));
`;
  return [
    "set +e",
    `node --input-type=commonjs -e ${shellQuote(nodeScript)}`,
    `if openclaw plugins inspect voiceclaw --json >/dev/null 2>&1; then printf '%s\\n' ${shellQuote(PLUGIN_PRESENT_MARKER)}; else printf '%s\\n' ${shellQuote(PLUGIN_MISSING_MARKER)}; fi`,
    "exit 0",
  ].join("\n");
}

function parseProbe(stdout: string): VoiceClawProbe | null {
  const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().startsWith("{"));
  if (!firstLine) return null;
  try {
    const value = JSON.parse(firstLine) as Partial<VoiceClawProbe>;
    if (
      typeof value.configReadable !== "boolean" ||
      typeof value.pluginEnabled !== "boolean" ||
      typeof value.voiceModeEnabled !== "boolean" ||
      typeof value.bridgeConfigured !== "boolean" ||
      typeof value.bridgeReachable !== "boolean"
    ) {
      return null;
    }
    return value as VoiceClawProbe;
  } catch {
    return null;
  }
}

function evaluateVoiceClawHealth(input: {
  readonly agent: string;
  readonly probe: VoiceClawProbe | null;
  readonly pluginPresent: boolean;
  readonly probedAt: string;
  readonly channelEnabledInRegistry: boolean;
  readonly presetInRegistry: boolean;
  readonly presetOnGateway: boolean | null;
}): ChannelHealthReport {
  const signals: DiagnosticSignal[] = [];
  signals.push(configSignal(input));
  signals.push(pluginSignal(input.pluginPresent));
  signals.push(policySignal(input));
  signals.push(bridgeSignal(input.probe));
  const verdict = !input.probe
    ? "probe_failed"
    : !input.channelEnabledInRegistry || !input.probe.pluginEnabled || !input.probe.voiceModeEnabled
      ? "config_gap"
      : !input.pluginPresent
        ? "plugin_missing"
        : !input.presetInRegistry || input.presetOnGateway === false
          ? "policy_gap"
          : !input.probe.bridgeReachable
            ? "bridge_unreachable"
            : "healthy";
  return {
    schemaVersion: 1,
    channel: "voiceclaw",
    agent: input.agent,
    verdict,
    probedAt: input.probedAt,
    signals,
    hints: signals.flatMap((signal) => (signal.hint ? [signal.hint] : [])),
  };
}

function configSignal(input: {
  readonly probe: VoiceClawProbe | null;
  readonly channelEnabledInRegistry: boolean;
}): DiagnosticSignal {
  if (!input.channelEnabledInRegistry) {
    return {
      label: "Rendered config",
      severity: "fail",
      detail: "VoiceClaw is not enabled in the persisted messaging plan",
      hint: "add the voiceclaw channel and rebuild the sandbox",
    };
  }
  if (!input.probe?.configReadable) {
    return {
      label: "Rendered config",
      severity: "fail",
      detail: "could not read the OpenClaw configuration",
      hint: "rebuild the sandbox, then re-run channels status",
    };
  }
  if (!input.probe.pluginEnabled || !input.probe.voiceModeEnabled) {
    return {
      label: "Rendered config",
      severity: "fail",
      detail: "VoiceClaw plugin or voice mode is not enabled in openclaw.json",
      hint: "rebuild the sandbox so the VoiceClaw manifest is rendered again",
    };
  }
  return {
    label: "Rendered config",
    severity: "ok",
    detail: "VoiceClaw plugin and voice mode are enabled",
  };
}

function pluginSignal(pluginPresent: boolean): DiagnosticSignal {
  return pluginPresent
    ? { label: "Plugin install", severity: "ok", detail: "VoiceClaw plugin is discoverable" }
    : {
        label: "Plugin install",
        severity: "fail",
        detail: "VoiceClaw plugin is not discoverable",
        hint: "rebuild after NemoClaw pins the published VoiceClaw plugin artifact",
      };
}

function policySignal(input: {
  readonly presetInRegistry: boolean;
  readonly presetOnGateway: boolean | null;
}): DiagnosticSignal {
  if (!input.presetInRegistry) {
    return {
      label: "Policy coverage",
      severity: "fail",
      detail: "voiceclaw preset is not recorded for the sandbox",
      hint: "add the voiceclaw channel so NemoClaw applies its policy preset",
    };
  }
  if (input.presetOnGateway === false) {
    return {
      label: "Policy coverage",
      severity: "fail",
      detail: "voiceclaw preset is missing from the gateway policy",
      hint: "rebuild the sandbox so the policy is reapplied",
    };
  }
  return {
    label: "Policy coverage",
    severity: input.presetOnGateway === null ? "info" : "ok",
    detail:
      input.presetOnGateway === null
        ? "voiceclaw preset recorded; gateway cross-check unavailable"
        : "voiceclaw preset applied and loaded on the gateway",
  };
}

function bridgeSignal(probe: VoiceClawProbe | null): DiagnosticSignal {
  if (!probe) {
    return {
      label: "Audio bridge",
      severity: "fail",
      detail: "VoiceClaw audio bridge probe did not complete",
      hint: "verify the sandbox is running, then re-run channels status",
    };
  }
  if (!probe.bridgeConfigured) {
    return {
      label: "Audio bridge",
      severity: "fail",
      detail: "VoiceClaw audio bridge URL is not configured",
      hint: "set VOICECLAW_AUDIO_BRIDGE_URL and rebuild the sandbox",
    };
  }
  return probe.bridgeReachable
    ? { label: "Audio bridge", severity: "ok", detail: "host audio bridge health check passed" }
    : {
        label: "Audio bridge",
        severity: "fail",
        detail: "host audio bridge health check failed",
        hint: "start the VoiceClaw audio bridge and verify host port 7880",
      };
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTristate(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function normalizeTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MS;
}
