// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import { compareChannelSets, probeChannelRuntimeStatus } from "../../channel-runtime-status";
import { CLI_NAME } from "../../cli/branding";
import {
  collectBuiltInMessagingChannelDiagnostics,
  type MessagingChannelDiagnosticSpec,
} from "../../messaging/diagnostics";
import { executeSandboxCommandForVerification } from "../../onboard/sandbox-verification-exec";
import { ROOT } from "../../runner";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { buildStatusCommandDeps } from "../../status-command-deps";
import type { DoctorCheck } from "./doctor-report";

const CHANNEL_STATUS_DIAGNOSTICS = collectBuiltInMessagingChannelDiagnostics();

function runtimeProbeUnavailableCheck(sandboxName: string, detail: string): DoctorCheck {
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "warn",
    detail,
    hint:
      `start the sandbox and rerun \`${CLI_NAME} ${sandboxName} doctor\`, ` +
      `or rebuild with \`${CLI_NAME} ${sandboxName} rebuild\` if the config file is missing`,
  };
}

function runtimeVisibilityCheck(
  sandboxName: string,
  enabledChannels: string[],
  visibleChannels: string[],
  configDir: string,
  configFile: string,
): DoctorCheck | null {
  const { missing } = compareChannelSets(enabledChannels, visibleChannels);
  if (missing.length === 0) return null;
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "warn",
    detail: `not visible to OpenClaw runtime: ${missing.join(", ")}`,
    hint:
      `the OpenClaw dashboard "Channels" panel will show "No channels found" for ` +
      `${missing.join(", ")}; inspect \`${configDir}/${configFile}\` ` +
      `and the gateway log with \`${CLI_NAME} ${sandboxName} logs\`, then re-run ` +
      `\`${CLI_NAME} ${sandboxName} rebuild\` if the channels block needs to be regenerated`,
  };
}

function runtimeConfigCheck(
  sandboxName: string,
  enabledChannels: string[],
  configuredChannels: string[],
  configDir: string,
  configFile: string,
): DoctorCheck | null {
  const { missing } = compareChannelSets(enabledChannels, configuredChannels);
  if (missing.length === 0) return null;
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "warn",
    detail: `missing from sandbox config: ${missing.join(", ")}`,
    hint:
      `\`${configDir}/${configFile}\` is missing the channel block ` +
      `for ${missing.join(", ")}; re-run \`${CLI_NAME} ${sandboxName} rebuild\` so the config is regenerated`,
  };
}

function runtimeLogUnavailableCheck(sandboxName: string, enabledChannels: string[]): DoctorCheck {
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "warn",
    detail: `${enabledChannels.join(", ")} present in config; gateway log unavailable, runtime startup not confirmed`,
    hint:
      `start the sandbox and rerun \`${CLI_NAME} ${sandboxName} doctor\`, or inspect ` +
      `the gateway log with \`${CLI_NAME} ${sandboxName} logs\``,
  };
}

function healthyRuntimeCheck(enabledChannels: string[]): DoctorCheck {
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "ok",
    detail: `${enabledChannels.join(", ")} acknowledged by OpenClaw runtime`,
  };
}

function unreachableRuntimeCheck(sandboxName: string): DoctorCheck {
  return {
    group: "Messaging",
    label: "Runtime channel registry",
    status: "info",
    detail: "skipped because the sandbox is not reachable through its named gateway",
    hint: `fix the gateway and live sandbox checks, then rerun \`${CLI_NAME} ${sandboxName} doctor\``,
  };
}

/**
 * Compare the registry's enabled channels with the runtime's config and log
 * evidence. A null result means the probe does not apply, so the caller omits
 * the line instead of rendering a no-op diagnostic.
 */
function channelRuntimeDoctorCheck(
  sandboxName: string,
  enabledChannels: string[],
  sb: SandboxEntry,
): DoctorCheck | null {
  if (enabledChannels.length === 0) return null;
  let agent: ReturnType<typeof loadAgent>;
  try {
    agent = loadAgent(sb.agent || "openclaw");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return runtimeProbeUnavailableCheck(
      sandboxName,
      `unable to resolve agent config paths: ${detail}`,
    );
  }
  if (agent.configPaths.format !== "json") return null;
  const configFilePath = `${agent.configPaths.dir}/${agent.configPaths.configFile}`;
  const runtime = probeChannelRuntimeStatus({
    configFilePath,
    executeSandboxCommand: (script: string) =>
      executeSandboxCommandForVerification(sandboxName, script),
  });
  if (!runtime.ok) return runtimeProbeUnavailableCheck(sandboxName, runtime.detail);
  if (runtime.logProbeOk) {
    return (
      runtimeVisibilityCheck(
        sandboxName,
        enabledChannels,
        runtime.visibleChannels,
        agent.configPaths.dir,
        agent.configPaths.configFile,
      ) ?? healthyRuntimeCheck(enabledChannels)
    );
  }
  return (
    runtimeConfigCheck(
      sandboxName,
      enabledChannels,
      runtime.configuredChannels,
      agent.configPaths.dir,
      agent.configPaths.configFile,
    ) ?? runtimeLogUnavailableCheck(sandboxName, enabledChannels)
  );
}

function getChannelStatusDiagnostic(channelName: string): MessagingChannelDiagnosticSpec | null {
  return (
    CHANNEL_STATUS_DIAGNOSTICS.find((diagnostic) => diagnostic.channelId === channelName) ?? null
  );
}

function formatDiagnosticTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function formatMessagingOverlapDoctorDetail(overlap: {
  readonly channel: string;
  readonly sandboxes: readonly [string, string];
  readonly message?: string;
}): string {
  const detail = overlap.message
    ? formatDiagnosticTemplate(overlap.message, {
        channel: overlap.channel,
        first: overlap.sandboxes[0],
        second: overlap.sandboxes[1],
      })
    : `'${overlap.sandboxes[0]}' and '${overlap.sandboxes[1]}' overlap`;
  return `${overlap.channel}: ${detail}`;
}

function configuredChannelsCheck(sandboxName: string, sb: SandboxEntry): DoctorCheck {
  const registeredChannels = registry.getConfiguredMessagingChannelsFromEntry(sb);
  const disabledChannels = new Set(registry.getDisabledMessagingChannelsFromEntry(sb));
  const channels = registeredChannels.filter((channel: string) => !disabledChannels.has(channel));
  const pausedChannels = registeredChannels.filter((channel: string) =>
    disabledChannels.has(channel),
  );
  if (registeredChannels.length === 0) {
    return {
      group: "Messaging",
      label: "Channels",
      status: "info",
      detail: "no messaging channels registered",
    };
  }
  if (channels.length === 0) {
    return {
      group: "Messaging",
      label: "Channels",
      status: "info",
      detail: `all messaging channels paused (${pausedChannels.join(", ")})`,
      hint: `run \`${CLI_NAME} ${sandboxName} channels start <channel>\` to re-enable one`,
    };
  }

  const statusDeps = buildStatusCommandDeps(ROOT);
  const degraded = statusDeps.checkMessagingBridgeHealth?.(sandboxName, channels, sb.agent) || [];
  const overlaps = (statusDeps.findMessagingOverlaps?.() ?? []).filter(
    (overlap) => channels.includes(overlap.channel) && overlap.sandboxes.includes(sandboxName),
  );
  const pausedSuffix =
    pausedChannels.length > 0 ? `; paused channels skipped: ${pausedChannels.join(", ")}` : "";
  const warnings = [
    ...degraded.map(
      (item: { channel: string; conflicts: number }) =>
        `${item.channel}: ${item.conflicts} conflict(s)`,
    ),
    ...overlaps.map(formatMessagingOverlapDoctorDetail),
  ];
  if (warnings.length > 0) {
    return {
      group: "Messaging",
      label: "Channels",
      status: "warn",
      detail: warnings.join("; ") + pausedSuffix,
      hint: `run \`${CLI_NAME} ${sandboxName} logs --follow\` for enabled bridge details`,
    };
  }

  const diagnostic = channels
    .map(getChannelStatusDiagnostic)
    .find((candidate) => candidate?.doctorWhenNoHealthSignals);
  if (!diagnostic?.doctorWhenNoHealthSignals) {
    return {
      group: "Messaging",
      label: "Channels",
      status: "ok",
      detail: `${channels.join(", ")} enabled; no recent conflict signatures${pausedSuffix}`,
    };
  }
  const context = {
    channel: diagnostic.channelId,
    channels: channels.join(", "),
    cli: CLI_NAME,
    pausedSuffix,
    sandbox: sandboxName,
  };
  return {
    group: "Messaging",
    label: "Channels",
    status: "info",
    detail: formatDiagnosticTemplate(diagnostic.doctorWhenNoHealthSignals.detail, context),
    hint: formatDiagnosticTemplate(diagnostic.doctorWhenNoHealthSignals.hint, context),
  };
}

export function collectMessagingDoctorChecks(
  sandboxName: string,
  sb: SandboxEntry,
  sandboxReachable: boolean,
): DoctorCheck[] {
  const checks = [configuredChannelsCheck(sandboxName, sb)];
  const registered = registry.getConfiguredMessagingChannelsFromEntry(sb);
  const disabled = new Set(registry.getDisabledMessagingChannelsFromEntry(sb));
  const enabled = registered.filter((channel: string) => !disabled.has(channel));
  const runtimeCheck = sandboxReachable
    ? channelRuntimeDoctorCheck(sandboxName, enabled, sb)
    : enabled.length > 0
      ? unreachableRuntimeCheck(sandboxName)
      : null;
  if (runtimeCheck) checks.push(runtimeCheck);
  return checks;
}
