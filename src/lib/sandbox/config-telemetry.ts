// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getTelemetryTarget,
  isTelemetryOperationActive,
  recordTelemetryTarget,
} from "../actions/telemetry/operation";
import { isTelemetryConfigurationKey } from "../domain/telemetry/event";
import {
  readModelSelectionProvenance,
  selectedModelProvenance,
} from "../domain/telemetry/provenance";
import { CLI_NAME } from "../cli/branding";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding/identity";
import { isConfigObject, type ConfigObject } from "../security/credential-filter";
import type { AgentConfigTarget } from "./agent-config";
import {
  readSandboxTelemetryEntry,
  updateSandboxTelemetrySelections,
} from "../state/registry/telemetry-selections";

export { recordTelemetryTarget, isTelemetryConfigurationKey };

export function persistConfigurationTelemetry(
  sandboxName: string,
  key: string,
  config: ConfigObject | null,
  pending: boolean | undefined,
  newModelSelection = false,
): boolean {
  if (!isTelemetryOperationActive() || !isTelemetryConfigurationKey(key)) return true;
  try {
    const entry = readSandboxTelemetryEntry(sandboxName);
    if (!entry) return false;
    const updates: Partial<typeof entry> =
      pending === undefined ? {} : { configurationApplyPending: pending ? true : undefined };
    if (config) {
      const modelConfig = isConfigObject(config.model) ? config.model : {};
      const model = modelConfig.default;
      const nativeProvider = modelConfig.provider;
      const upstream = isConfigObject(config._nemoclaw_upstream)
        ? config._nemoclaw_upstream.provider
        : undefined;
      const provider = nativeProvider === "custom" ? upstream : nativeProvider;
      const apiMode = modelConfig.api_mode;
      const api =
        apiMode === undefined || apiMode === ""
          ? "openai-completions"
          : apiMode === "anthropic_messages"
            ? "anthropic-messages"
            : apiMode === "codex_responses"
              ? "openai-responses"
              : typeof apiMode === "string"
                ? apiMode
                : null;
      const previous = readModelSelectionProvenance(entry.nativeModelSelectionProvenance);
      const source =
        key === "model.default" && newModelSelection
          ? "custom"
          : previous && previous.model === model && previous.provider === provider
            ? previous.modelSource
            : undefined;
      updates.nativeModelSelectionProvenance =
        typeof model === "string" && typeof provider === "string" && source
          ? selectedModelProvenance({
              model,
              provider,
              endpointUrl:
                nativeProvider === "custom" && upstream === entry.provider
                  ? entry.endpointUrl
                  : undefined,
              preferredInferenceApi: api,
              modelSource: source,
            })
          : undefined;
    }
    return updateSandboxTelemetrySelections(entry, updates);
  } catch {
    return false;
  }
}

/** Retire native selection evidence only after the command proved its native route sync. */
export function retireNativeConfigurationTelemetry(sandboxName: string, gatewayName: string): void {
  if (!isTelemetryOperationActive()) return;
  const target = getTelemetryTarget(sandboxName, gatewayName);
  if (!target) return;
  try {
    const entry = readSandboxTelemetryEntry(sandboxName);
    if (entry && resolveSandboxGatewayName(entry) !== gatewayName)
      throw new Error("Native selection metadata owner changed");
    if (entry && entry.nativeModelSelectionProvenance === undefined) return;
    if (
      entry &&
      updateSandboxTelemetrySelections(entry, { nativeModelSelectionProvenance: undefined })
    )
      return;
  } catch {
    // Metadata failure does not undo a proved native application.
  }
  recordTelemetryTarget({
    ...target,
    verificationStatus: "collection_error",
    metadataErrors: [{ category: "native_model_source" }],
  });
}

/** Enforce the existing host config-mutation surface before any write or receipt. */
export function configSetUnsupportedAgentMessage(
  target: AgentConfigTarget,
  sandboxName: string,
  configKey: string,
  quote: (value: string) => string,
): string | readonly string[] | null {
  if (target.agentName === "openclaw")
    return [
      "  config set is not available for OpenClaw because OpenClaw owns its configuration.",
      `  Connect to the sandbox and use the native command instead: openclaw config set ${quote(configKey)} <value>`,
    ];
  if (target.agentName !== "hermes" && target.format === "toml")
    return `  config set is not available for '${target.agentName}': its config is baked into the sandbox image at build time. To change it, re-onboard with the new selection (e.g. ${CLI_NAME} onboard --agent dcode --name ${quote(sandboxName)} --fresh).`;
  return target.agentName === "hermes"
    ? null
    : `  config set is available only for Hermes; '${target.agentName}' config was not changed. Use the agent's native configuration command.`;
}
