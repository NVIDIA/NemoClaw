// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../core/json-types";
import { normalizeWebSearchConfig, type WebSearchConfig } from "../inference/web-search";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../name-validation";
import { isOnboardMachineState } from "../onboard/machine/transitions";
import { parseCheckpointDecision } from "./onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointBindings,
  type CheckpointDecision,
  type CheckpointEffectGroupName,
  type CheckpointEffectGroupRecord,
  type CheckpointLoadResult,
  type CheckpointMessagingSelection,
  type CheckpointProviderBinding,
  type CheckpointResourceProfile,
  type CheckpointSandboxIdentity,
  type OnboardCheckpoint,
} from "./onboard-checkpoint-types";

const EFFECT_GROUP_NAMES: readonly CheckpointEffectGroupName[] = [
  "web_search_provider",
  "messaging_providers",
  "sandbox_create",
  "sandbox_register",
];

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    entries.push(entry);
  }
  return entries;
}

function readCanonicalIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function parseSandboxIdentityValue(value: unknown): CheckpointSandboxIdentity | null {
  if (!isObjectRecord(value)) return null;
  const name = readString(value.name);
  const agent = readString(value.agent);
  if (name === null || agent === null || agent.length === 0) return null;
  if (name.length > NAME_MAX_LENGTH || !NAME_VALID_PATTERN.test(name)) return null;
  return { name, agent };
}

function parseResourceProfileValue(value: unknown): CheckpointResourceProfile | null {
  if (!isObjectRecord(value)) return null;
  const cpu = readString(value.cpu);
  const memory = readString(value.memory);
  return cpu !== null && memory !== null ? { cpu, memory } : null;
}

function parseWebSearchValue(value: unknown): WebSearchConfig | null {
  if (!isObjectRecord(value)) return null;
  return normalizeWebSearchConfig(value as Partial<WebSearchConfig>);
}

function parseMessagingValue(value: unknown): CheckpointMessagingSelection | null {
  if (!isObjectRecord(value)) return null;
  const selectedChannels = readStringArray(value.selectedChannels);
  const disabledChannels = readStringArray(value.disabledChannels);
  if (selectedChannels === null || disabledChannels === null) return null;
  return { selectedChannels, disabledChannels };
}

function parseEffectGroupRecord(value: unknown): CheckpointEffectGroupRecord | null {
  if (!isObjectRecord(value)) return null;
  const completedAt = readCanonicalIsoTimestamp(value.completedAt);
  const fingerprint = readString(value.fingerprint);
  if (completedAt === null || fingerprint === null || fingerprint.length === 0) return null;
  return { completedAt, fingerprint };
}

function parseEffectGroups(
  value: unknown,
): Partial<Record<CheckpointEffectGroupName, CheckpointEffectGroupRecord>> | null {
  if (!isObjectRecord(value)) return null;
  const groups: Partial<Record<CheckpointEffectGroupName, CheckpointEffectGroupRecord>> = {};
  for (const name of EFFECT_GROUP_NAMES) {
    const raw = value[name];
    if (raw === undefined) continue;
    const record = parseEffectGroupRecord(raw);
    if (!record) return null;
    groups[name] = record;
  }
  return groups;
}

function parseProviderBinding(value: unknown): CheckpointProviderBinding | null {
  if (!isObjectRecord(value)) return null;
  const name = readString(value.name);
  const type = readString(value.type);
  const credentialEnv = readString(value.credentialEnv);
  if (!name || !type || !credentialEnv) return null;
  return { name, type, credentialEnv };
}

function parseProviderBindings(value: unknown): CheckpointProviderBinding[] | null {
  if (!Array.isArray(value)) return null;
  const bindings: CheckpointProviderBinding[] = [];
  for (const entry of value) {
    const binding = parseProviderBinding(entry);
    if (!binding) return null;
    bindings.push(binding);
  }
  return bindings;
}

function parseBindings(value: unknown): CheckpointBindings | null {
  if (!isObjectRecord(value)) return null;
  const credentialEnvs = readStringArray(value.credentialEnvs);
  const registeredProviders = parseProviderBindings(value.registeredProviders);
  if (credentialEnvs === null || registeredProviders === null) return null;
  return { credentialEnvs, registeredProviders };
}

function requireDecision<T>(
  raw: unknown,
  parseValue: (value: unknown) => T | null,
): CheckpointDecision<T> | null {
  return parseCheckpointDecision(raw, parseValue);
}

function parseCurrentSchema(value: Record<string, unknown>): OnboardCheckpoint | null {
  const sessionId = readString(value.sessionId);
  const machineState = value.machineState;
  const updatedAt = readCanonicalIsoTimestamp(value.updatedAt);
  if (sessionId === null || updatedAt === null) return null;
  if (typeof machineState !== "string" || !isOnboardMachineState(machineState)) return null;

  const sandboxIdentity = requireDecision(value.sandboxIdentity, parseSandboxIdentityValue);
  const webSearch = requireDecision(value.webSearch, parseWebSearchValue);
  const messaging = requireDecision(value.messaging, parseMessagingValue);
  const resourceProfile = requireDecision(value.resourceProfile, parseResourceProfileValue);
  const effectGroups = parseEffectGroups(value.effectGroups);
  const bindings = parseBindings(value.bindings);
  if (!sandboxIdentity || !webSearch || !messaging || !resourceProfile) return null;
  if (!effectGroups || !bindings) return null;

  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    machineState,
    updatedAt,
    sandboxIdentity,
    webSearch,
    messaging,
    resourceProfile,
    effectGroups,
    bindings,
  };
}

export function inspectCheckpoint(raw: unknown): CheckpointLoadResult {
  if (raw === undefined || raw === null) return { status: "none" };
  if (!isObjectRecord(raw)) return { status: "corrupt" };

  const version = raw.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { status: "corrupt" };
  }
  if (version > CHECKPOINT_SCHEMA_VERSION) {
    return { status: "unsupported_future", foundVersion: version };
  }
  if (version === CHECKPOINT_SCHEMA_VERSION) {
    const checkpoint = parseCurrentSchema(raw);
    return checkpoint ? { status: "loaded", checkpoint } : { status: "corrupt" };
  }
  return { status: "corrupt" };
}

export function serializeCheckpoint(checkpoint: OnboardCheckpoint): Record<string, unknown> {
  return {
    schemaVersion: checkpoint.schemaVersion,
    sessionId: checkpoint.sessionId,
    machineState: checkpoint.machineState,
    updatedAt: checkpoint.updatedAt,
    sandboxIdentity: checkpoint.sandboxIdentity,
    webSearch: checkpoint.webSearch,
    messaging: checkpoint.messaging,
    resourceProfile: checkpoint.resourceProfile,
    effectGroups: checkpoint.effectGroups,
    bindings: checkpoint.bindings,
  };
}
