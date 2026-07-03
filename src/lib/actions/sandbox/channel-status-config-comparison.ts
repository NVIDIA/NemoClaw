// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderedConfigVisibilityKey } from "../../messaging";
import type {
  ChannelConfigInputSpec,
  MessagingSerializableValue,
  SandboxMessagingInputReference,
} from "../../messaging/manifest";
import type { DiagnosticSignal } from "../../sandbox/whatsapp-diagnostics";
import {
  booleanConfigValue,
  configInputDetail,
  configValuesEqual,
} from "./channel-status-config-values";

export type ChannelStatusConfigSignal = DiagnosticSignal & {
  readonly kind: "config-input" | "rendered-config-source";
};

export interface ConfigRenderSource extends RenderedConfigVisibilityKey {
  readonly resolvedTarget: string;
}

export type ConfigSourceRead =
  | {
      readonly ok: true;
      readonly value: MessagingSerializableValue | undefined;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

type SandboxMessagingInputWithValue = SandboxMessagingInputReference & {
  readonly value: Exclude<MessagingSerializableValue, null | undefined>;
};

type ExpectedConfigValue = {
  readonly value: MessagingSerializableValue | undefined;
  readonly detail: string;
  readonly hasValue: boolean;
};

export function configInputSignal(
  input: ChannelConfigInputSpec,
  planInput: SandboxMessagingInputReference | undefined,
  renderSources: readonly ConfigRenderSource[],
  sourceValues: ReadonlyMap<string, ConfigSourceRead>,
): ChannelStatusConfigSignal | null {
  const label = configInputLabel(input, planInput);
  const expected = expectedConfigValue(input, planInput);
  const sources = renderSources.filter((source) => source.inputId === input.id);
  if (sources.length === 0) return null;

  const comparisons = sources.map((source) =>
    compareConfigSource(input, expected, source, sourceValues),
  );
  const checkedComparisons = comparisons.filter((comparison) => comparison.checked);
  const hasMismatch = checkedComparisons.some((comparison) => !comparison.matches);
  const allSourcesChecked =
    checkedComparisons.length === comparisons.length && checkedComparisons.length > 0;
  const hasUncheckedExpectedValue = expected.hasValue && !allSourcesChecked;
  return {
    kind: "config-input",
    label,
    severity:
      hasMismatch || hasUncheckedExpectedValue
        ? "warn"
        : expected.hasValue && allSourcesChecked
          ? "ok"
          : "info",
    detail: Array.from(new Set(comparisons.map((comparison) => comparison.detail))).join("; "),
  };
}

function planInputHasValue(
  input: SandboxMessagingInputReference | undefined,
): input is SandboxMessagingInputWithValue {
  return input?.value !== undefined && input.value !== null;
}

function configInputLabel(
  input: ChannelConfigInputSpec,
  planInput: SandboxMessagingInputReference | undefined,
): string {
  const label = input.prompt?.label ?? input.envKey ?? input.id;
  const envKey = input.envKey ?? planInput?.sourceEnv;
  if (!envKey || label === envKey) return label;
  return `${label} (${envKey})`;
}

function expectedConfigValue(
  input: ChannelConfigInputSpec,
  planInput: SandboxMessagingInputReference | undefined,
): ExpectedConfigValue {
  if (planInputHasValue(planInput)) {
    return {
      value: planInput.value,
      detail: configInputValueDetail(input, planInput.value),
      hasValue: true,
    };
  }

  const defaultValue = input.defaultValue?.trim();
  if (defaultValue) {
    return {
      value: defaultValue,
      detail: configInputValueDetail(input, defaultValue, { isDefault: true }),
      hasValue: true,
    };
  }

  return {
    value: undefined,
    detail: configInputDetail(undefined),
    hasValue: false,
  };
}

function configInputValueDetail(
  input: ChannelConfigInputSpec,
  value: MessagingSerializableValue | undefined,
  options: { readonly isDefault?: boolean } = {},
): string {
  const booleanValue = value === undefined ? null : booleanConfigValue(value);
  const labelKey =
    booleanValue === null ? configInputDetail(value) : booleanValue === true ? "1" : "0";
  const label = input.diagnostics?.valueLabels?.[labelKey];
  if (label) {
    return options.isDefault ? `${label} (${labelKey}, default)` : `${label} (${labelKey})`;
  }
  const renderedValue = configInputDetail(value);
  return options.isDefault ? `${renderedValue} (default)` : renderedValue;
}

function compareConfigSource(
  input: ChannelConfigInputSpec,
  expected: ExpectedConfigValue,
  source: ConfigRenderSource,
  sourceValues: ReadonlyMap<string, ConfigSourceRead>,
): { readonly checked: boolean; readonly matches: boolean; readonly detail: string } {
  const actual = sourceValues.get(configSourceKey(source));
  if (!actual?.ok) {
    return {
      checked: false,
      matches: false,
      detail: `${expected.detail} (not checked)`,
    };
  }
  const matches = configValuesEqual(expected.value, actual.value);
  return {
    checked: true,
    matches,
    detail: matches
      ? expected.detail
      : `expected ${expected.detail}; rendered ${configInputValueDetail(input, actual.value)}`,
  };
}

export function configSourceKey(source: ConfigRenderSource): string {
  return `${source.resolvedTarget}:${source.kind}:${source.key}`;
}
