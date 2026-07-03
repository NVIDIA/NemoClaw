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
import type { ChannelConfigInputSpec, MessagingAgentId } from "../../messaging/manifest";
import * as registry from "../../state/registry";
import {
  type ChannelStatusConfigSignal,
  type ConfigRenderSource,
  type ConfigSourceRead,
  configInputSignal,
  configSourceKey,
} from "./channel-status-config-comparison";

export type { ChannelStatusConfigSignal } from "./channel-status-config-comparison";

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

export type ChannelStatusConfigOptions = {
  inputIds?: readonly string[];
};

export function buildConfigStatusSignals(
  sandboxName: string,
  channelName: string,
  entry: ReturnType<typeof registry.getSandbox>,
  agent: AgentDefinition,
  deps: ChannelStatusConfigDeps,
  options: ChannelStatusConfigOptions = {},
): ChannelStatusConfigSignal[] {
  const plan = registry.getMessagingPlanFromEntry(entry);
  const channelPlan = plan?.channels.find((channel) => channel.channelId === channelName);
  if (!channelPlan?.configured) return [];

  const manifest = channelManifestRegistry.get(channelName);
  const agentId = tryGetMessagingAgentId(
    { name: plan?.agent ?? agent.name },
    channelManifestRegistry.list(),
  );
  const parser = manifest ? getBuiltInRenderedConfigParser(manifest.id) : null;
  const requestedInputIds = options.inputIds ? new Set(options.inputIds) : null;
  const manifestConfigInputs = (manifest?.inputs ?? []).filter(
    (input): input is ChannelConfigInputSpec =>
      input.kind === "config" && (!requestedInputIds || requestedInputIds.has(input.id)),
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
  const signals: ChannelStatusConfigSignal[] = configSourceReadSignals(sandboxName, sourceReads);

  for (const input of manifestConfigInputs) {
    const signal = configInputSignal(
      input,
      configInputs.get(input.id),
      renderSources,
      sourceReads.sourceValues,
    );
    if (signal) signals.push(signal);
  }

  return signals;
}

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
): ChannelStatusConfigSignal[] {
  const signals: ChannelStatusConfigSignal[] = [];
  for (const [target, read] of sourceReads.targetReads.entries()) {
    if (read.ok) continue;
    signals.push({
      kind: "rendered-config-source",
      label: "Rendered config source",
      severity: "warn",
      detail: `${read.error}; config comparisons not checked`,
      hint: `inspect \`${target}\` with \`${CLI_NAME} ${sandboxName} exec -- cat ${target}\`, then re-run \`${CLI_NAME} ${sandboxName} rebuild\` if the channel block needs to be regenerated`,
    });
  }
  for (const [target, error] of sourceReads.targetParseErrors.entries()) {
    signals.push({
      kind: "rendered-config-source",
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
