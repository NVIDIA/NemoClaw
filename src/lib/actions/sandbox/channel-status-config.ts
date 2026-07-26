// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import YAML from "yaml";
import type { AgentDefinition } from "../../agent/defs";
import { CLI_NAME } from "../../cli/branding";
import { shellQuote } from "../../core/shell-quote";
import type {
  RenderedChannelConfigParser,
  RenderedConfigSource,
  RenderedConfigVisibilityKey,
} from "../../messaging";
import {
  createBuiltInChannelManifestRegistry,
  getBuiltInRenderedConfigParser,
  tryGetMessagingAgentId,
} from "../../messaging";
import type { DiagnosticSignal } from "../../messaging/channels/channel-health";
import type {
  ChannelConfigInputSpec,
  MessagingAgentId,
  MessagingSerializableValue,
  SandboxMessagingInputReference,
} from "../../messaging/manifest";
import * as registry from "../../state/registry";
import {
  booleanConfigValue,
  configInputDetail,
  configValuesEqual,
} from "./channel-status-config-values";

const CONFIG_STATUS_TIMEOUT_MS = 5_000;
const CONFIG_STATUS_MAX_SOURCE_BYTES = 64 * 1024;
const channelManifestRegistry = createBuiltInChannelManifestRegistry();

type ExecRunner = (
  sandboxName: string,
  command: string,
  timeoutMs?: number,
) => {
  status: number;
  stdout: string;
  stderr: string;
} | null;

export type ChannelStatusConfigDeps = {
  execSandbox: ExecRunner;
};

export function buildConfigStatusSignals(
  sandboxName: string,
  channelName: string,
  entry: ReturnType<typeof registry.getSandbox>,
  agent: AgentDefinition,
  deps: ChannelStatusConfigDeps,
): DiagnosticSignal[] {
  const plan = registry.getMessagingPlanFromEntry(entry);
  const channelPlan = plan?.channels.find((channel) => channel.channelId === channelName);
  if (!channelPlan?.configured) return [];

  const manifest = channelManifestRegistry.get(channelName);
  const agentId = tryGetMessagingAgentId(
    { name: plan?.agent ?? agent.name },
    channelManifestRegistry.list(),
  );
  const parser = manifest ? getBuiltInRenderedConfigParser(manifest.id) : null;
  const manifestConfigInputs = (manifest?.inputs ?? []).filter(
    (input): input is ChannelConfigInputSpec => input.kind === "config",
  );
  const manifestConfigInputIds = new Set(manifestConfigInputs.map((input) => input.id));
  const renderSources =
    parser && manifest && agentId
      ? resolveRenderedConfigSources(
          parser
            .listConfigVisibilityKeys({ manifest, agentId, inputs: channelPlan.inputs })
            .filter((key) => manifestConfigInputIds.has(key.inputId)),
          agentId,
          agent,
        )
      : [];
  const sourceReads = parser
    ? readConfigSourceValues(sandboxName, renderSources, parser, deps)
    : emptyConfigSourceReads();
  const configInputs = new Map(
    channelPlan.inputs
      .filter((input) => input.kind === "config")
      .map((input) => [input.inputId, input] as const),
  );
  const signals: DiagnosticSignal[] = configSourceReadSignals(sandboxName, sourceReads);

  for (const input of manifestConfigInputs) {
    const signal = configInputSignal(input, configInputs.get(input.id), renderSources, sourceReads);
    if (signal) signals.push(signal);
  }

  return signals;
}

function configInputSignal(
  input: ChannelConfigInputSpec,
  planInput: SandboxMessagingInputReference | undefined,
  renderSources: readonly ConfigRenderSource[],
  sourceReads: ConfigSourceReads,
): DiagnosticSignal | null {
  const label = configInputLabel(input, planInput);
  const expected = expectedConfigValue(input, planInput);
  const sources = renderSources.filter((source) => source.inputId === input.id);
  if (sources.length === 0) {
    return null;
  }

  const comparisons = sources.map((source) =>
    compareConfigSource(input, expected, source, sourceReads.sourceValues),
  );
  const checkedComparisons = comparisons.filter((comparison) => comparison.checked);
  const hasMismatch = checkedComparisons.some((comparison) => !comparison.matches);
  const allSourcesChecked =
    checkedComparisons.length === comparisons.length && checkedComparisons.length > 0;
  const hasUncheckedExpectedValue = expected.hasValue && !allSourcesChecked;
  return {
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

type SandboxMessagingInputWithValue = SandboxMessagingInputReference & {
  readonly value: Exclude<MessagingSerializableValue, null | undefined>;
};

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

type ExpectedConfigValue = {
  readonly value: MessagingSerializableValue | undefined;
  readonly detail: string;
  readonly hasValue: boolean;
};

function expectedConfigValue(
  input: ChannelConfigInputSpec,
  planInput: SandboxMessagingInputReference | undefined,
): ExpectedConfigValue {
  if (planInputHasValue(planInput)) {
    return {
      value: planInput.value,
      detail: configInputDisplayDetail(input, planInput.value),
      hasValue: true,
    };
  }

  const defaultValue = input.defaultValue?.trim();
  if (defaultValue) {
    return {
      value: defaultValue,
      detail: `${configInputDisplayDetail(input, defaultValue)} (default)`,
      hasValue: true,
    };
  }

  return {
    value: undefined,
    detail: configInputDisplayDetail(input, undefined),
    hasValue: false,
  };
}

function configInputDisplayDetail(
  input: ChannelConfigInputSpec,
  value: MessagingSerializableValue | undefined,
): string {
  if (input.id === "requireMention" && input.envKey === "TELEGRAM_REQUIRE_MENTION") {
    const booleanValue = value === undefined || value === null ? null : booleanConfigValue(value);
    if (booleanValue !== null) return booleanValue ? "yes" : "no";
  }
  return configInputDetail(value);
}

interface ConfigRenderSource extends RenderedConfigVisibilityKey {
  readonly resolvedTarget: string;
}

type ConfigSourceRead =
  | {
      readonly ok: true;
      readonly value: MessagingSerializableValue | undefined;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

type ConfigTargetRead =
  | {
      readonly ok: true;
      readonly contents: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

type ConfigSourceReads = {
  readonly sourceValues: ReadonlyMap<string, ConfigSourceRead>;
  readonly targetReads: ReadonlyMap<string, ConfigTargetRead>;
  readonly targetParseErrors: ReadonlyMap<string, string>;
};

type ParsedConfigSourceRead =
  | {
      readonly ok: true;
      readonly source: RenderedConfigSource;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

function configSourceReadSignals(
  sandboxName: string,
  sourceReads: ConfigSourceReads,
): DiagnosticSignal[] {
  const signals: DiagnosticSignal[] = [];
  for (const [target, read] of sourceReads.targetReads.entries()) {
    if (read.ok) continue;
    signals.push({
      label: "Rendered config source",
      severity: "warn",
      detail: `${read.error}; config comparisons not checked`,
      hint: `inspect \`${target}\` with \`${CLI_NAME} ${sandboxName} exec -- cat ${target}\`, then re-run \`${CLI_NAME} ${sandboxName} rebuild\` if the channel block needs to be regenerated`,
    });
  }
  for (const [target, error] of sourceReads.targetParseErrors.entries()) {
    signals.push({
      label: "Rendered config source",
      severity: "warn",
      detail: `${error}; config comparisons not checked`,
      hint: `inspect \`${target}\` with \`${CLI_NAME} ${sandboxName} exec -- cat ${target}\`, then re-run \`${CLI_NAME} ${sandboxName} rebuild\` if the channel block needs to be regenerated`,
    });
  }
  return signals;
}

function emptyConfigSourceReads(): ConfigSourceReads {
  return { sourceValues: new Map(), targetReads: new Map(), targetParseErrors: new Map() };
}

function resolveRenderedConfigSources(
  sources: readonly RenderedConfigVisibilityKey[],
  agentId: MessagingAgentId,
  agent: AgentDefinition,
): ConfigRenderSource[] {
  return sources.flatMap((source) => {
    const resolvedTarget = resolveConfigTarget(source.target, agentId, agent);
    return resolvedTarget ? [{ ...source, resolvedTarget }] : [];
  });
}

function resolveConfigTarget(
  target: string,
  agentId: MessagingAgentId,
  agent: AgentDefinition,
): string | null {
  if (agentId === "openclaw" && target === "openclaw.json") {
    return `${agent.configPaths.dir}/${agent.configPaths.configFile}`;
  }
  const configDir = agent.configPaths.dir.replace(/\/+$/, "");
  if (agentId === "openclaw" && target.startsWith("~/.openclaw/")) {
    return `${configDir}/${target.slice("~/.openclaw/".length)}`;
  }
  if (agentId === "hermes" && target.startsWith("~/.hermes/")) {
    return `${configDir}/${target.slice("~/.hermes/".length)}`;
  }
  if (target.startsWith("/sandbox/")) return target;
  return null;
}

function readConfigSourceValues(
  sandboxName: string,
  sources: readonly ConfigRenderSource[],
  parser: RenderedChannelConfigParser,
  deps: ChannelStatusConfigDeps,
): ConfigSourceReads {
  const targetReads = new Map<string, ConfigTargetRead>();
  for (const target of new Set(sources.map((source) => source.resolvedTarget))) {
    // Targets are resolved only from built-in channel manifests via resolveConfigTarget.
    // Keep this command path closed to user-provided targets before broadening shellQuote use.
    const result = deps.execSandbox(
      sandboxName,
      `head -c ${CONFIG_STATUS_MAX_SOURCE_BYTES + 1} ${shellQuote(target)}`,
      CONFIG_STATUS_TIMEOUT_MS,
    );
    targetReads.set(
      target,
      result &&
        result.status === 0 &&
        Buffer.byteLength(result.stdout, "utf8") <= CONFIG_STATUS_MAX_SOURCE_BYTES
        ? { ok: true, contents: result.stdout }
        : result && result.status === 0
          ? { ok: false, error: `rendered config source too large: ${target}` }
          : { ok: false, error: `could not read ${target}` },
    );
  }

  const reads = new Map<string, ConfigSourceRead>();
  const targetParseErrors = new Map<string, string>();
  for (const source of sources) {
    const targetRead = targetReads.get(source.resolvedTarget);
    const key = configSourceKey(source);
    if (!targetRead?.ok) {
      reads.set(key, {
        ok: false,
        error: `${source.resolvedTarget} unavailable`,
      });
      continue;
    }
    const parsed = parseRenderedConfigSource(
      targetRead.contents,
      source.resolvedTarget,
      source.kind,
    );
    if (!parsed.ok) targetParseErrors.set(source.resolvedTarget, parsed.error);
    reads.set(
      key,
      parsed.ok ? { ok: true, value: parser.getValue(source, parsed.source) } : parsed,
    );
  }
  return { sourceValues: reads, targetReads, targetParseErrors };
}

function parseEnvLines(raw: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    entries.set(key, unquoteEnvValue(value));
  }
  return entries;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseRenderedConfigSource(
  raw: string,
  target: string,
  kind: ConfigRenderSource["kind"],
): ParsedConfigSourceRead {
  if (kind === "env") return { ok: true, source: { kind: "env", entries: parseEnvLines(raw) } };
  try {
    const value =
      target.endsWith(".yaml") || target.endsWith(".yml") ? YAML.parse(raw) : JSON.parse(raw);
    return { ok: true, source: { kind: "structured", value } };
  } catch {
    return { ok: false, error: `could not parse ${target}` };
  }
}

function compareConfigSource(
  input: ChannelConfigInputSpec,
  expected: ExpectedConfigValue,
  source: ConfigRenderSource,
  sourceValues: ReadonlyMap<string, ConfigSourceRead>,
): { readonly checked: boolean; readonly matches: boolean; readonly detail: string } {
  const actual = sourceValues.get(configSourceKey(source));
  if (!actual) {
    return {
      checked: false,
      matches: false,
      detail: `${expected.detail} (not checked)`,
    };
  }
  if (!actual.ok) {
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
      : `expected ${expected.detail}; rendered ${configInputDisplayDetail(input, actual.value)}`,
  };
}

function configSourceKey(source: ConfigRenderSource): string {
  return `${source.resolvedTarget}:${source.kind}:${source.key}`;
}
