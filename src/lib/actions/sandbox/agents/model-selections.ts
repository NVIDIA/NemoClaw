// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dataRecord } from "../../../domain/telemetry/values";
import { resolveSandboxGatewayName } from "../../../onboard/gateway-binding/identity";
import {
  readModelAssignmentSelection,
  readModelSelectionProvenance,
  type ModelAssignmentSelection,
} from "../../../domain/telemetry/provenance";
import {
  readSandboxTelemetryEntry,
  updateSandboxTelemetrySelections,
} from "../../../state/registry/telemetry-selections";
import type { SandboxEntry } from "../../../state/registry/types";

export { readSandboxTelemetryEntry, updateSandboxTelemetrySelections };

export function readAgentSelectionEntry(sandboxName: string): SandboxEntry | null {
  try {
    const entry = readSandboxTelemetryEntry(sandboxName);
    return entry && (entry.agent ?? "openclaw") === "openclaw" ? entry : null;
  } catch {
    return null;
  }
}

function nativeAgent(config: unknown, agentId: string): Record<string, unknown> | null {
  const agents = dataRecord(dataRecord(config)?.agents);
  const entries = dataRecord(agents?.entries);
  if (entries) return dataRecord(entries[agentId]);
  return Array.isArray(agents?.list)
    ? (agents.list.map(dataRecord).find((entry) => entry?.id === agentId) ?? null)
    : null;
}

function selectedReference(config: unknown, selection: ModelAssignmentSelection): unknown {
  const agent = nativeAgent(config, selection.agentId);
  const defaults = dataRecord(dataRecord(dataRecord(config)?.agents)?.defaults);
  if (selection.assignment === "subagent")
    return dataRecord(agent?.subagents)?.model ?? dataRecord(defaults?.subagents)?.model;
  const model = agent?.model;
  const primary = typeof model === "string" ? model : dataRecord(model)?.primary;
  if (selection.assignment === "override") return primary;
  if (selection.assignment === "primary" && primary === undefined)
    return typeof defaults?.model === "string"
      ? defaults.model
      : dataRecord(defaults?.model)?.primary;
  return undefined;
}

function customSelection(agentId: string, assignment: "override" | "subagent", reference: unknown) {
  return readModelAssignmentSelection({
    schemaVersion: 1,
    agentId,
    assignment,
    reference,
    modelSource: "custom",
  });
}

/** Fresh manifest choices are manual inputs; retain only exactly applied native slots. */
export function verifiedManifestModelSelections(
  config: unknown,
  manifest: { agents: unknown[]; main?: unknown },
): ModelAssignmentSelection[] | null {
  const selections: ModelAssignmentSelection[] = [];
  const candidates = [...manifest.agents, { ...dataRecord(manifest.main), id: "main" }];
  for (const candidate of candidates) {
    const agent = dataRecord(candidate);
    if (!agent || typeof agent.id !== "string") return null;
    for (const [assignment, reference] of [
      ["override", agent.model],
      ["subagent", dataRecord(agent.subagents)?.model],
    ] as const) {
      if (reference === undefined) continue;
      const selection = customSelection(agent.id, assignment, reference);
      if (!selection || selectedReference(config, selection) !== selection.reference) return null;
      selections.push(selection);
    }
  }
  return selections;
}

/** Explicit native roster ownership needs no OpenClaw startup; absent ownership stays unknown. */
export function configuredAgentIds(config: unknown): string[] | null | undefined {
  const root = dataRecord(config);
  if (!root) return null;
  const agents = dataRecord(root.agents);
  if (!agents) return root.agents === undefined ? undefined : null;
  let rows: [unknown, unknown][];
  if (agents.entries !== undefined) {
    const entries = dataRecord(agents.entries);
    if (!entries) return null;
    rows = Object.entries(entries);
  } else if (agents.list !== undefined) {
    if (!Array.isArray(agents.list)) return null;
    rows = agents.list.map((entry) => [dataRecord(entry)?.id, entry]);
  } else return undefined;
  const ids = new Set<string>();
  for (const [id, value] of rows) {
    const entry = dataRecord(value);
    if (
      typeof id !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) ||
      !entry ||
      (entry.id !== undefined && entry.id !== id) ||
      ids.has(id)
    )
      return null;
    ids.add(id);
  }
  return [...ids].sort();
}

function hasNativeAgentRoster(config: unknown): boolean {
  return Array.isArray(configuredAgentIds(config));
}

/** Retain historical origins only for native slots still owned by the recreated target. */
export function restoredAgentModelSelections(
  config: unknown,
  previous: SandboxEntry,
  current: SandboxEntry,
): ModelAssignmentSelection[] | null {
  if (
    previous.pendingCreateIdentity !== undefined ||
    previous.pendingRouteReservation !== undefined ||
    current.pendingCreateIdentity !== undefined ||
    current.pendingRouteReservation !== undefined ||
    previous.name !== current.name ||
    (previous.agent ?? "openclaw") !== (current.agent ?? "openclaw") ||
    resolveSandboxGatewayName(previous) !== resolveSandboxGatewayName(current) ||
    (previous.gatewayName && previous.gatewayName !== resolveSandboxGatewayName(previous)) ||
    (current.gatewayName && current.gatewayName !== resolveSandboxGatewayName(current))
  )
    return null;
  if (!hasNativeAgentRoster(config)) return null;
  const selections = previous.modelAssignmentSelections ?? [];
  if (!Array.isArray(selections)) return null;
  const retained: ModelAssignmentSelection[] = [];
  for (const value of selections) {
    const selection = readModelAssignmentSelection(value);
    if (!selection) return null;
    const agent = nativeAgent(config, selection.agentId);
    if (!agent) continue;
    const defaults = dataRecord(dataRecord(dataRecord(config)?.agents)?.defaults);
    const fallbacks = dataRecord(agent.model)?.fallbacks ?? dataRecord(defaults?.model)?.fallbacks;
    const matched =
      selection.assignment === "fallback"
        ? Array.isArray(fallbacks) && fallbacks.includes(selection.reference)
        : selectedReference(config, selection) === selection.reference;
    if (matched) retained.push(selection);
  }
  if (previous.modelSelectionProvenance !== undefined) {
    const receipt = readModelSelectionProvenance(previous.modelSelectionProvenance);
    if (!receipt || receipt.model !== previous.model || receipt.provider !== previous.provider)
      return null;
    const agents = dataRecord(dataRecord(config)?.agents);
    const entries = dataRecord(agents?.entries);
    const ids = entries
      ? Object.keys(entries)
      : (agents?.list as Record<string, unknown>[]).map((agent) => agent.id as string);
    for (const agentId of ids) {
      const selection = readModelAssignmentSelection({
        schemaVersion: 1,
        agentId,
        assignment: "primary",
        reference: `inference/${receipt.model}`,
        modelSource: receipt.modelSource,
      });
      if (!selection || selectedReference(config, selection) !== selection.reference) continue;
      const provider = dataRecord(dataRecord(dataRecord(config)?.models)?.providers);
      const inference = dataRecord(provider?.inference);
      if (
        typeof inference?.baseUrl !== "string" ||
        !/^https:\/\/inference\.local(?:\/v1)?\/?$/.test(inference.baseUrl) ||
        inference.api !== receipt.apiFamily
      )
        return null;
      if (!retained.some((slot) => slot.agentId === agentId && slot.assignment === "primary"))
        retained.push(selection);
    }
  }
  return retained;
}

/** Retain sources across restore and retire slots only after proven native deletion/replacement. */
export function persistVerifiedAgentModelSelections(
  expected: SandboxEntry | null,
  config: unknown,
  additions: readonly ModelAssignmentSelection[],
  deletedAgentIds: readonly string[] = [],
  retainedSelections?: readonly ModelAssignmentSelection[],
): boolean {
  if (!expected || (expected.agent ?? "openclaw") !== "openclaw" || !hasNativeAgentRoster(config))
    return false;
  if (
    additions.some(
      (selection) =>
        !readModelAssignmentSelection(selection) ||
        !["override", "subagent"].includes(selection.assignment) ||
        selectedReference(config, selection) !== selection.reference,
    ) ||
    deletedAgentIds.some((agentId) => nativeAgent(config, agentId) !== null)
  )
    return false;
  const previous = retainedSelections ?? expected.modelAssignmentSelections ?? [];
  if (!Array.isArray(previous)) return false;
  const retained: ModelAssignmentSelection[] = [];
  for (const value of previous) {
    const selection = readModelAssignmentSelection(value);
    if (!selection) return false;
    if (
      !deletedAgentIds.includes(selection.agentId) &&
      !additions.some(
        (replacement) =>
          replacement.agentId === selection.agentId &&
          replacement.assignment === selection.assignment,
      )
    )
      retained.push(selection);
  }
  try {
    return updateSandboxTelemetrySelections(expected, {
      modelAssignmentSelections: [...retained, ...additions],
      ...(expected.nativeModelSelectionProvenance === undefined
        ? {}
        : { nativeModelSelectionProvenance: undefined }),
    });
  } catch {
    return false;
  }
}

/** Explicit native --model is a manual choice; native interactive origin is not guessed. */
export function explicitAgentModel(command: readonly string[]): string | null {
  let model: string | null = null;
  for (let index = 3; index < command.length && command[index] !== "--"; index += 1) {
    if (command[index] === "--model") model = command[++index] ?? null;
    else if (command[index].startsWith("--model=")) model = command[index].slice(8);
  }
  return model || null;
}

export function verifiedAddedAgentModelSelection(
  config: unknown,
  agentId: string,
  model: string,
): ModelAssignmentSelection | null {
  const selection = customSelection(agentId, "override", model);
  return selection && selectedReference(config, selection) === selection.reference
    ? selection
    : null;
}
