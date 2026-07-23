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
const PLUGIN_PRESENT_MARKER = "NEMOCLAW_VOICE_CALL_PLUGIN_PRESENT";
const PLUGIN_MISSING_MARKER = "NEMOCLAW_VOICE_CALL_PLUGIN_MISSING";

export type VoiceClawStatusHealthHookOptions = ChannelStatusHealthHookOptions;

type VoiceClawProbe = {
  readonly configReadable: boolean;
  readonly pluginEnabled: boolean;
  readonly twilioConfigured: boolean;
  readonly webhookConfigured: boolean;
  readonly nvidiaAsrConfigured: boolean;
  readonly nvidiaTtsConfigured: boolean;
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

export function buildVoiceClawProbeNodeScript(): string {
  return String.raw`
const fs = require("fs");
const result = {
  configReadable: false,
  pluginEnabled: false,
  twilioConfigured: false,
  webhookConfigured: false,
  nvidiaAsrConfigured: false,
  nvidiaTtsConfigured: false,
};
try {
  const config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
  result.configReadable = true;
  const plugin = config?.plugins?.entries?.["voice-call"];
  result.pluginEnabled = plugin?.enabled === true && plugin?.config?.enabled === true;
  result.twilioConfigured =
    plugin?.config?.provider === "twilio" &&
    typeof plugin?.config?.twilio?.accountSid === "string" &&
    plugin.config.twilio.accountSid.startsWith("AC") &&
    typeof plugin?.config?.twilio?.authToken === "string" &&
    plugin.config.twilio.authToken.length > 0 &&
    typeof plugin?.config?.fromNumber === "string" &&
    plugin.config.fromNumber.startsWith("+");
  result.webhookConfigured =
    plugin?.config?.serve?.bind === "0.0.0.0" &&
    plugin?.config?.serve?.port === 3334 &&
    plugin?.config?.serve?.path === "/voice/webhook" &&
    typeof plugin?.config?.publicUrl === "string" &&
    plugin.config.publicUrl.startsWith("https://") &&
    plugin.config.publicUrl.endsWith("/voice/webhook");
  result.nvidiaTtsConfigured =
    plugin?.config?.tts?.provider === "nvidia" &&
    config?.messages?.tts?.provider === "nvidia";
  result.nvidiaAsrConfigured =
    config?.tools?.media?.audio?.enabled === true &&
    Array.isArray(config?.tools?.media?.audio?.models) &&
    config.tools.media.audio.models.some((model) => model?.provider === "nvidia");
} catch {}
process.stdout.write(JSON.stringify(result) + "\n");
`;
}

function buildVoiceClawProbeScript(): string {
  const nodeScript = buildVoiceClawProbeNodeScript();
  return [
    "set +e",
    `node --input-type=commonjs -e ${shellQuote(nodeScript)}`,
    `if openclaw plugins inspect voice-call --json >/dev/null 2>&1; then printf '%s\\n' ${shellQuote(PLUGIN_PRESENT_MARKER)}; else printf '%s\\n' ${shellQuote(PLUGIN_MISSING_MARKER)}; fi`,
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
      typeof value.twilioConfigured !== "boolean" ||
      typeof value.webhookConfigured !== "boolean" ||
      typeof value.nvidiaAsrConfigured !== "boolean" ||
      typeof value.nvidiaTtsConfigured !== "boolean"
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
  const signals: DiagnosticSignal[] = [
    configSignal(input),
    pluginSignal(input.pluginPresent),
    policySignal(input),
    twilioSignal(input.probe),
    nvidiaSpeechSignal(input.probe),
  ];
  const verdict = !input.probe
    ? "probe_failed"
    : !input.channelEnabledInRegistry || !input.probe.pluginEnabled
      ? "config_gap"
      : !input.pluginPresent
        ? "plugin_missing"
        : !input.presetInRegistry || input.presetOnGateway === false
          ? "policy_gap"
          : !input.probe.twilioConfigured || !input.probe.webhookConfigured
            ? "twilio_config_gap"
            : !input.probe.nvidiaAsrConfigured || !input.probe.nvidiaTtsConfigured
              ? "nvidia_speech_config_gap"
              : "ready";
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
  if (!input.probe?.configReadable || !input.probe.pluginEnabled) {
    return {
      label: "Rendered config",
      severity: "fail",
      detail: "the OpenClaw voice-call plugin configuration is unavailable or disabled",
      hint: "rebuild the sandbox so the VoiceClaw manifest is rendered again",
    };
  }
  return {
    label: "Rendered config",
    severity: "ok",
    detail: "OpenClaw voice-call is enabled",
  };
}

function pluginSignal(pluginPresent: boolean): DiagnosticSignal {
  return pluginPresent
    ? { label: "Plugin install", severity: "ok", detail: "voice-call plugin is discoverable" }
    : {
        label: "Plugin install",
        severity: "fail",
        detail: "voice-call plugin is not discoverable",
        hint: "rebuild the sandbox so the pinned voice-call plugin is installed",
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
        : "Twilio and NVIDIA HTTP policy is loaded on the gateway",
  };
}

function twilioSignal(probe: VoiceClawProbe | null): DiagnosticSignal {
  if (probe?.twilioConfigured && probe.webhookConfigured) {
    return {
      label: "Twilio setup",
      severity: "ok",
      detail: "Twilio credentials, caller number, and HTTPS webhook are configured",
    };
  }
  return {
    label: "Twilio setup",
    severity: "fail",
    detail: "Twilio credentials, caller number, or HTTPS webhook configuration is incomplete",
    hint: "re-add VoiceClaw with the Twilio account, number, and public webhook URL",
  };
}

function nvidiaSpeechSignal(probe: VoiceClawProbe | null): DiagnosticSignal {
  if (probe?.nvidiaAsrConfigured && probe.nvidiaTtsConfigured) {
    return {
      label: "NVIDIA speech",
      severity: "ok",
      detail: "NVIDIA batch ASR and TTS are configured in OpenClaw",
    };
  }
  return {
    label: "NVIDIA speech",
    severity: "fail",
    detail: "NVIDIA batch ASR or TTS configuration is missing",
    hint: "rebuild the sandbox so the VoiceClaw speech preload and config are applied",
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
