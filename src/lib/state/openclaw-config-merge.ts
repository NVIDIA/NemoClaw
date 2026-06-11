// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "../core/json-types.js";

/**
 * Ownership contract for restoring OpenClaw's durable openclaw.json snapshot.
 *
 * Rebuild creates a fresh OpenClaw config before snapshot restore runs. The
 * snapshot is sanitized and may contain stale OpenShell placeholder revisions,
 * old channel enablement, or no gateway block at all, so restore must merge by
 * ownership instead of replacing the freshly generated file wholesale.
 */
export const OPENCLAW_CONFIG_RESTORE_OWNERSHIP = {
  /** Fresh rebuild output owns these whole top-level runtime sections. */
  runtimeSections: ["gateway", "proxy", "diagnostics"],
  /** NemoClaw-managed channels reflect current add/remove/start/stop state. */
  managedChannels: ["discord", "slack", "telegram", "whatsapp", "wechat", "openclaw-weixin"],
  /** Current generated entries win by id; backup-only user entries are kept. */
  currentGeneratedEntryMaps: ["plugins.entries"],
  /**
   * Provider entries are reconciled by id: the fresh rebuild owns routing and
   * credential fields, while backed-up non-secret model tuning is restored.
   */
  providerRuntimeOwnedFields: ["baseUrl", "api", "apiKey"],
  /** A model entry's routing identity is owned by the fresh rebuild. */
  modelRuntimeOwnedFields: ["id", "name"],
  /** Durable user-owned top-level sections are inherited from the backup. */
  backupDurableSections: ["mcp", "mcpServers", "customAgents", "agents"],
} as const;

const MANAGED_OPENCLAW_CHANNELS = new Set<string>(
  OPENCLAW_CONFIG_RESTORE_OWNERSHIP.managedChannels,
);

const PROVIDER_RUNTIME_OWNED_FIELDS = OPENCLAW_CONFIG_RESTORE_OWNERSHIP.providerRuntimeOwnedFields;
const MODEL_RUNTIME_OWNED_FIELDS = OPENCLAW_CONFIG_RESTORE_OWNERSHIP.modelRuntimeOwnedFields;

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return undefined as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeJsonObjects(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = cloneJson(base);
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    if (isPlainJsonObject(existing) && isPlainJsonObject(value)) {
      merged[key] = mergeJsonObjects(existing, value);
    } else {
      merged[key] = cloneJson(value);
    }
  }
  return merged;
}

function mergeOpenClawChannels(backupChannels: unknown, currentChannels: unknown): unknown {
  if (!isPlainJsonObject(backupChannels)) return cloneJson(currentChannels);

  const merged: Record<string, unknown> = isPlainJsonObject(currentChannels)
    ? cloneJson(currentChannels)
    : {};

  for (const [key, value] of Object.entries(backupChannels)) {
    if (key === "defaults") {
      merged[key] =
        isPlainJsonObject(value) && isPlainJsonObject(merged[key])
          ? mergeJsonObjects(merged[key] as Record<string, unknown>, value)
          : cloneJson(value);
      continue;
    }

    if (MANAGED_OPENCLAW_CHANNELS.has(key)) {
      // Freshly generated channel blocks carry current OpenShell placeholder
      // revisions and current start/stop/add/remove state. Never resurrect a
      // managed channel that the fresh config omitted, and never overwrite a
      // present managed channel with a stale backed-up account block.
      continue;
    }

    const existing = merged[key];
    merged[key] =
      isPlainJsonObject(existing) && isPlainJsonObject(value)
        ? mergeJsonObjects(existing, value)
        : cloneJson(value);
  }
  return merged;
}

function mergeOpenClawEntryMap(
  backupEntries: unknown,
  currentEntries: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainJsonObject(backupEntries) && !isPlainJsonObject(currentEntries)) return undefined;
  return {
    ...(isPlainJsonObject(backupEntries) ? cloneJson(backupEntries) : {}),
    // Current generated entries win so rebuild does not restore stale runtime
    // placeholders, model routing, or plugin enablement for NemoClaw-managed ids.
    ...(isPlainJsonObject(currentEntries) ? cloneJson(currentEntries) : {}),
  };
}

function modelEntryId(entry: unknown): string | null {
  if (isPlainJsonObject(entry) && typeof entry.id === "string") return entry.id;
  return null;
}

function restoreRuntimeOwnedFields(
  merged: Record<string, unknown>,
  current: Record<string, unknown>,
  ownedFields: readonly string[],
): void {
  for (const field of ownedFields) {
    if (field in current) merged[field] = cloneJson(current[field]);
    else delete merged[field];
  }
}

/**
 * Reconcile one model entry whose id matches across backup and current.
 *
 * The fresh rebuild owns the model's routing identity (`id`/`name`); the
 * backup restores the user's non-secret tuning (`reasoning`, `cost`,
 * `contextWindow`, `maxTokens`, `compat`, `input`, …) that the regenerated
 * defaults would otherwise reset (issue #5202).
 */
function mergeOpenClawModelEntry(
  backupModel: Record<string, unknown>,
  currentModel: Record<string, unknown>,
): Record<string, unknown> {
  const merged = mergeJsonObjects(currentModel, backupModel);
  restoreRuntimeOwnedFields(merged, currentModel, MODEL_RUNTIME_OWNED_FIELDS);
  return merged;
}

/**
 * Merge a provider's `models` array. The fresh rebuild defines the model set
 * and order; for each fresh model with an id present in the backup, the
 * backed-up tuning is restored. Backup-only and id-less stale models are not
 * resurrected so rebuild's regenerated routing stays authoritative.
 */
function mergeOpenClawModelArray(backupModels: unknown, currentModels: unknown): unknown {
  if (!Array.isArray(currentModels)) return cloneJson(backupModels ?? currentModels);

  const backupById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(backupModels)) {
    for (const entry of backupModels) {
      const id = modelEntryId(entry);
      if (id && isPlainJsonObject(entry) && !backupById.has(id)) backupById.set(id, entry);
    }
  }

  return currentModels.map((entry) => {
    const id = modelEntryId(entry);
    const backupMatch = id ? backupById.get(id) : undefined;
    if (backupMatch && isPlainJsonObject(entry)) return mergeOpenClawModelEntry(backupMatch, entry);
    return cloneJson(entry);
  });
}

/**
 * Reconcile one provider entry whose id matches across backup and current.
 * Runtime-owned routing/credential fields stay fresh; backed-up non-secret
 * config (including per-model tuning) is restored.
 */
function mergeOpenClawProviderEntry(
  backupProvider: Record<string, unknown>,
  currentProvider: Record<string, unknown>,
): Record<string, unknown> {
  const merged = mergeJsonObjects(currentProvider, backupProvider);
  restoreRuntimeOwnedFields(merged, currentProvider, PROVIDER_RUNTIME_OWNED_FIELDS);
  if ("models" in currentProvider || "models" in backupProvider) {
    merged.models = mergeOpenClawModelArray(backupProvider.models, currentProvider.models);
  }
  return merged;
}

/**
 * Merge `models.providers`. Backup-only providers are inherited; fresh-only
 * providers win as generated; matching providers are reconciled by ownership
 * so the fresh rebuild keeps routing/credentials while the backup restores
 * user-owned non-secret model metadata (issue #5202).
 */
function mergeOpenClawProviderMap(
  backupProviders: unknown,
  currentProviders: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainJsonObject(backupProviders) && !isPlainJsonObject(currentProviders)) return undefined;
  const backup = isPlainJsonObject(backupProviders) ? backupProviders : {};
  const current = isPlainJsonObject(currentProviders) ? currentProviders : {};

  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(backup)) {
    merged[key] = cloneJson(value);
  }
  for (const [key, value] of Object.entries(current)) {
    const backupEntry = backup[key];
    merged[key] =
      isPlainJsonObject(backupEntry) && isPlainJsonObject(value)
        ? mergeOpenClawProviderEntry(backupEntry, value)
        : cloneJson(value);
  }
  return merged;
}

function mergeOpenClawModels(backupModels: unknown, currentModels: unknown): unknown {
  if (!isPlainJsonObject(backupModels)) return cloneJson(currentModels);
  if (!isPlainJsonObject(currentModels)) return cloneJson(backupModels);

  const merged = mergeJsonObjects(currentModels, backupModels);
  const providers = mergeOpenClawProviderMap(backupModels.providers, currentModels.providers);
  if (providers) merged.providers = providers;
  return merged;
}

function mergeOpenClawPlugins(backupPlugins: unknown, currentPlugins: unknown): unknown {
  if (!isPlainJsonObject(backupPlugins)) return cloneJson(currentPlugins);
  if (!isPlainJsonObject(currentPlugins)) return cloneJson(backupPlugins);

  const merged = mergeJsonObjects(currentPlugins, backupPlugins);
  const entries = mergeOpenClawEntryMap(backupPlugins.entries, currentPlugins.entries);
  if (entries) merged.entries = entries;
  return merged;
}

export function mergeOpenClawRestoredConfig(
  backedUpConfig: unknown,
  currentConfig: unknown,
): unknown {
  if (!isPlainJsonObject(backedUpConfig)) return cloneJson(currentConfig ?? backedUpConfig);
  if (!isPlainJsonObject(currentConfig)) return cloneJson(backedUpConfig);

  const merged = mergeJsonObjects(currentConfig, backedUpConfig);

  for (const key of OPENCLAW_CONFIG_RESTORE_OWNERSHIP.runtimeSections) {
    if (key in currentConfig) merged[key] = cloneJson(currentConfig[key]);
    else delete merged[key];
  }

  merged.channels = mergeOpenClawChannels(backedUpConfig.channels, currentConfig.channels);
  merged.models = mergeOpenClawModels(backedUpConfig.models, currentConfig.models);
  merged.plugins = mergeOpenClawPlugins(backedUpConfig.plugins, currentConfig.plugins);

  return merged;
}
