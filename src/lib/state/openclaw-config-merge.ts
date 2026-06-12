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
  currentGeneratedEntryMaps: ["models.providers", "plugins.entries"],
  /** Durable user-owned top-level sections are inherited from the backup. */
  backupDurableSections: ["mcpServers", "customAgents", "agents"],
} as const;

const MANAGED_OPENCLAW_CHANNELS = new Set<string>(
  OPENCLAW_CONFIG_RESTORE_OWNERSHIP.managedChannels,
);

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

function mergeOpenClawModels(backupModels: unknown, currentModels: unknown): unknown {
  if (!isPlainJsonObject(backupModels)) return cloneJson(currentModels);
  if (!isPlainJsonObject(currentModels)) return cloneJson(backupModels);

  const merged = mergeJsonObjects(currentModels, backupModels);
  const providers = mergeOpenClawEntryMap(backupModels.providers, currentModels.providers);
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
