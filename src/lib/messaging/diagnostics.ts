// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInChannelManifestRegistry } from "./channels";
import type {
  ChannelInputSpec,
  ChannelManifest,
  ChannelPolicyPresetReference,
  MessagingAgentId,
  MessagingSerializableValue,
  SandboxMessagingChannelPlan,
  SandboxMessagingInputReference,
  SandboxMessagingPlan,
} from "./manifest";

export interface MessagingChannelDiagnosticSpec {
  readonly channelId: string;
  readonly policyPresets: readonly string[];
  readonly preferredDefault: boolean;
  readonly deepProbe?: "in-sandbox-qr";
  readonly doctorWhenNoHealthSignals?: {
    readonly detail: string;
    readonly hint: string;
  };
  readonly visibleConfigInputs: readonly VisibleChannelConfigInput[];
}

export interface VisibleChannelConfigInput {
  readonly inputId: string;
  readonly label: string;
  readonly envKey?: string;
  readonly defaultValue?: string;
  readonly validValues: readonly string[];
  readonly valueDisplay?: Readonly<Record<string, string>>;
  readonly agentApplicability?: readonly MessagingAgentId[];
}

export function collectBuiltInMessagingChannelDiagnostics(
  options: { readonly agent?: MessagingAgentId } = {},
): MessagingChannelDiagnosticSpec[] {
  return collectMessagingChannelDiagnostics(
    createBuiltInChannelManifestRegistry().listAvailable(
      options.agent ? { agent: options.agent } : undefined,
    ),
  );
}

export function collectMessagingChannelDiagnostics(
  manifests: readonly ChannelManifest[],
): MessagingChannelDiagnosticSpec[] {
  return manifests.map((manifest) => {
    const deepProbe = manifest.auth.mode === "in-sandbox-qr" ? "in-sandbox-qr" : undefined;
    return {
      channelId: manifest.id,
      policyPresets: policyPresetNames(manifest.policyPresets),
      preferredDefault: deepProbe !== undefined,
      ...(deepProbe ? { deepProbe, doctorWhenNoHealthSignals: qrDeepProbeDoctorHint() } : {}),
      visibleConfigInputs: collectVisibleConfigInputs(manifest.inputs),
    };
  });
}

function collectVisibleConfigInputs(
  inputs: readonly ChannelInputSpec[],
): readonly VisibleChannelConfigInput[] {
  return inputs.flatMap((input) => {
    if (input.kind !== "config") return [];
    if (input.safeToPrintInDiagnostics !== true) return [];
    if (!input.validValues || input.validValues.length === 0) return [];
    const label = input.prompt?.label;
    if (!label) return [];
    return [
      {
        inputId: input.id,
        label,
        ...(input.envKey ? { envKey: input.envKey } : {}),
        ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue } : {}),
        validValues: [...input.validValues],
        ...(input.valueDisplay ? { valueDisplay: { ...input.valueDisplay } } : {}),
        ...(input.agentApplicability ? { agentApplicability: [...input.agentApplicability] } : {}),
      } satisfies VisibleChannelConfigInput,
    ];
  });
}

/**
 * Resolve the diagnostic detail text for one visible config input, given the
 * raw value persisted in the channel plan (or `undefined` when only the
 * manifest default is available). Returns `null` when neither a persisted
 * value nor a default exists so callers can skip the entry rather than emit
 * an empty signal.
 *
 * When the persisted value is not in the input's declared `validValues`
 * allowlist, the renderer returns bounded text (`invalid persisted value
 * (expected: …)`) rather than echoing the raw value, so a corrupted or
 * tampered plan cannot bypass the diagnostic boundary.
 */
export type VisibleConfigDisplay = {
  readonly detail: string;
  readonly source: "persisted" | "default" | "invalid";
};

export function resolveVisibleConfigDisplay(
  input: VisibleChannelConfigInput,
  planInput: SandboxMessagingInputReference | undefined,
): VisibleConfigDisplay | null {
  if (input.validValues.length === 0) return null;
  const planInputPresent = planInput !== undefined;
  const rawValue = planInput?.value;
  const persistedScalar =
    planInputPresent && rawValue !== undefined && rawValue !== null && rawValue !== "";
  if (persistedScalar) {
    if (!isPrintableScalar(rawValue)) {
      return invalidPersistedDisplay(input, "unsupported type");
    }
    const valueText = stringifyScalar(rawValue);
    if (!input.validValues.includes(valueText)) {
      return invalidPersistedDisplay(input, `expected: ${input.validValues.join(" | ")}`);
    }
    const mapped = input.valueDisplay?.[valueText];
    if (mapped && input.envKey) {
      return { detail: `${mapped} (${input.envKey}=${valueText})`, source: "persisted" };
    }
    if (mapped) {
      return { detail: `${mapped} (${valueText})`, source: "persisted" };
    }
    return { detail: valueText, source: "persisted" };
  }
  if (planInputPresent) {
    return invalidPersistedDisplay(input, `expected: ${input.validValues.join(" | ")}`);
  }
  if (input.defaultValue !== undefined) {
    const mapped = input.valueDisplay?.[input.defaultValue];
    if (mapped) {
      return { detail: `${mapped} (default)`, source: "default" };
    }
    return { detail: `${input.defaultValue} (default)`, source: "default" };
  }
  return null;
}

function invalidPersistedDisplay(
  _input: VisibleChannelConfigInput,
  reason: string,
): VisibleConfigDisplay {
  return {
    detail: `invalid persisted value (${reason})`,
    source: "invalid",
  };
}

/**
 * Normalised visible-config record consumed by `channels status` and
 * `doctor`. The diagnostic shared helper walks a channel plan once and
 * returns one record per renderable input; the calling command then maps
 * the record onto its own signal/check shape.
 */
export interface VisibleConfigRecord {
  readonly input: VisibleChannelConfigInput;
  readonly display: VisibleConfigDisplay;
}

/**
 * Walk one diagnostic spec's `visibleConfigInputs` against a sandbox plan
 * and return only the records that should be rendered for the supplied
 * agent runtime. Inputs whose `agentApplicability` excludes the agent are
 * skipped so an OpenClaw-only setting never appears for a Hermes sandbox.
 */
export function collectVisibleConfigRecords(
  diagnostic: MessagingChannelDiagnosticSpec,
  plan: SandboxMessagingPlan | null,
  channelId: string,
  agent: MessagingAgentId | null,
): VisibleConfigRecord[] {
  const channelPlan: SandboxMessagingChannelPlan | null =
    plan?.channels.find((channel) => channel.channelId === channelId) ?? null;
  const records: VisibleConfigRecord[] = [];
  for (const input of diagnostic.visibleConfigInputs) {
    if (!inputAppliesToAgent(input, agent)) continue;
    const planInput = channelPlan?.inputs.find((entry) => entry.inputId === input.inputId);
    const display = resolveVisibleConfigDisplay(input, planInput);
    if (!display) continue;
    records.push({ input, display });
  }
  return records;
}

function inputAppliesToAgent(
  input: VisibleChannelConfigInput,
  agent: MessagingAgentId | null,
): boolean {
  if (!input.agentApplicability || input.agentApplicability.length === 0) return true;
  if (!agent) return false;
  return input.agentApplicability.includes(agent);
}

function isPrintableScalar(value: MessagingSerializableValue): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function stringifyScalar(value: string | number | boolean): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function qrDeepProbeDoctorHint(): MessagingChannelDiagnosticSpec["doctorWhenNoHealthSignals"] {
  return {
    detail:
      "{channels} enabled; {channel} inbound delivery is not inferred from conflict signatures{pausedSuffix}",
    hint: "run `{cli} {sandbox} channels status --channel {channel}` to probe inbound delivery",
  };
}

function policyPresetNames(presets: readonly ChannelPolicyPresetReference[] | undefined): string[] {
  return (presets ?? []).map((preset) => (typeof preset === "string" ? preset : preset.name));
}
