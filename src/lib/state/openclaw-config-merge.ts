// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "../core/json-types.js";
import { listOpenClawManagedChannelNames } from "../messaging/channels/index.js";
import type { OpenClawImagePluginInstall } from "./openclaw-plugin-restore.js";

const MANAGED_OPENCLAW_CHANNEL_NAMES = listOpenClawManagedChannelNames();

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
  managedChannels: MANAGED_OPENCLAW_CHANNEL_NAMES,
  /** Current generated entries win by id; backup-only user entries are kept. */
  currentGeneratedEntryMaps: ["plugins.entries"],
  /** Fresh web-search selection owns these bundled/external plugin entries. */
  managedWebSearchPluginEntries: ["brave", "tavily"],
  /** Fresh web-search selection owns this path, including its absence. */
  managedWebSearchConfigPaths: ["tools.web.search"],
  /**
   * Provider entries are reconciled by id: the fresh rebuild owns routing and
   * credential fields, while backed-up non-secret model tuning is restored.
   */
  providerRuntimeOwnedFields: ["baseUrl", "api", "apiKey"],
  /** A model entry's routing identity is owned by the fresh rebuild. */
  modelRuntimeOwnedFields: ["id", "name"],
  /** Durable user-owned top-level sections are inherited from the backup. */
  backupDurableSections: ["mcp", "mcpServers", "customAgents", "agents"],
  /** NemoClaw's cross-agent disclosure selection owns this generated key. */
  currentGeneratedToolFields: ["toolSearch"],
} as const;

const MANAGED_OPENCLAW_CHANNELS = new Set<string>(
  OPENCLAW_CONFIG_RESTORE_OWNERSHIP.managedChannels,
);

const PROVIDER_RUNTIME_OWNED_FIELDS = OPENCLAW_CONFIG_RESTORE_OWNERSHIP.providerRuntimeOwnedFields;
const MODEL_RUNTIME_OWNED_FIELDS = OPENCLAW_CONFIG_RESTORE_OWNERSHIP.modelRuntimeOwnedFields;
const MANAGED_WEB_SEARCH_PLUGIN_ENTRIES = new Set<string>(
  OPENCLAW_CONFIG_RESTORE_OWNERSHIP.managedWebSearchPluginEntries,
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

function mergeOpenClawChannels(
  backupChannels: unknown,
  currentChannels: unknown,
  previousImagePluginIds?: ReadonlySet<string>,
): unknown {
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

    if (MANAGED_OPENCLAW_CHANNELS.has(key) || previousImagePluginIds?.has(key)) {
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
  previousImagePluginIds?: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!isPlainJsonObject(backupEntries) && !isPlainJsonObject(currentEntries)) return undefined;
  const merged: Record<string, unknown> = {};
  if (isPlainJsonObject(backupEntries)) {
    for (const [key, value] of Object.entries(backupEntries)) {
      if (previousImagePluginIds?.has(key)) continue;
      // Search-provider plugins are selected by the fresh rebuild. Omitting
      // one is meaningful: provider switches and disablement must not restore
      // a stale Brave/Tavily entry from the durable snapshot.
      if (MANAGED_WEB_SEARCH_PLUGIN_ENTRIES.has(key)) continue;
      merged[key] = cloneJson(value);
    }
  }
  if (isPlainJsonObject(currentEntries)) {
    // Current generated entries win so rebuild does not restore stale runtime
    // placeholders, model routing, or plugin enablement for NemoClaw-managed ids.
    Object.assign(merged, cloneJson(currentEntries));
  }
  return merged;
}

function mergeOpenClawPluginLoad(
  backupLoad: unknown,
  currentLoad: unknown,
  previousImagePluginLoadPaths?: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const backup = isPlainJsonObject(backupLoad) ? backupLoad : {};
  const current = isPlainJsonObject(currentLoad) ? currentLoad : {};
  const merged = mergeJsonObjects(current, backup);
  const currentPaths = Array.isArray(current.paths)
    ? current.paths.filter((entry): entry is string => typeof entry === "string")
    : [];
  const backupPaths = Array.isArray(backup.paths)
    ? backup.paths.filter(
        (entry): entry is string =>
          typeof entry === "string" && !previousImagePluginLoadPaths?.has(entry),
      )
    : [];
  const paths = [...new Set([...currentPaths, ...backupPaths])];
  if (Array.isArray(current.paths) || Array.isArray(backup.paths)) merged.paths = paths;
  else delete merged.paths;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function mergeOpenClawPluginIdList(
  backupValue: unknown,
  currentValue: unknown,
  previousImagePluginIds?: ReadonlySet<string>,
  currentOppositeIds: ReadonlySet<string> = new Set(),
): string[] | undefined {
  const backup = stringArray(backupValue);
  const current = stringArray(currentValue);
  if (!backup && !current) return undefined;
  return [
    ...new Set([
      ...(current ?? []),
      ...(backup ?? []).filter(
        (id) => !previousImagePluginIds?.has(id) && !currentOppositeIds.has(id),
      ),
    ]),
  ];
}

function mergeOpenClawPluginSlots(
  backupSlots: unknown,
  currentSlots: unknown,
  previousImagePluginIds?: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!isPlainJsonObject(backupSlots) && !isPlainJsonObject(currentSlots)) return undefined;
  const merged: Record<string, unknown> = {};
  if (isPlainJsonObject(backupSlots)) {
    for (const [key, value] of Object.entries(backupSlots)) {
      if (typeof value === "string" && previousImagePluginIds?.has(value)) continue;
      merged[key] = cloneJson(value);
    }
  }
  if (isPlainJsonObject(currentSlots)) Object.assign(merged, cloneJson(currentSlots));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

type OpenClawImagePluginOwnership = {
  ids?: ReadonlySet<string>;
  loadPaths?: ReadonlySet<string>;
};

function imagePluginOwnership(
  installs?: readonly OpenClawImagePluginInstall[],
): OpenClawImagePluginOwnership {
  if (installs === undefined) return {};
  const ids = new Set<string>();
  const loadPaths = new Set<string>();
  for (const install of installs) {
    if (!Array.isArray(install.loadPaths)) {
      throw new Error("OpenClaw image plugin provenance is missing explicit load paths");
    }
    ids.add(install.id);
    for (const loadPath of install.loadPaths) loadPaths.add(loadPath);
  }
  return { ids, loadPaths };
}

function removedImagePluginIds(
  previous: OpenClawImagePluginOwnership,
  fresh: OpenClawImagePluginOwnership,
): ReadonlySet<string> | undefined {
  if (!previous.ids) return undefined;
  return new Set([...previous.ids].filter((id) => !fresh.ids?.has(id)));
}

function mergeOpenClawTools(backupTools: unknown, currentTools: unknown): unknown {
  if (!isPlainJsonObject(backupTools)) return cloneJson(currentTools);
  if (!isPlainJsonObject(currentTools) && currentTools !== undefined && currentTools !== null) {
    return cloneJson(currentTools);
  }
  const current = isPlainJsonObject(currentTools) ? currentTools : {};

  const merged = mergeJsonObjects(current, backupTools);
  const backupWeb = isPlainJsonObject(backupTools.web) ? backupTools.web : {};
  const currentWeb = isPlainJsonObject(current.web) ? current.web : {};
  const mergedWeb = mergeJsonObjects(currentWeb, backupWeb);

  // The fresh generator owns tools.web.search, including omission when web
  // search is disabled. Preserve unrelated user web-tool settings around it.
  if ("search" in currentWeb) mergedWeb.search = cloneJson(currentWeb.search);
  else delete mergedWeb.search;

  if (Object.keys(mergedWeb).length > 0) merged.web = mergedWeb;
  else delete merged.web;

  // Tool Search is generated from NemoClaw's current disclosure selection.
  // Its absence is authoritative, just like omission of web.search above.
  for (const field of OPENCLAW_CONFIG_RESTORE_OWNERSHIP.currentGeneratedToolFields) {
    if (field in current) merged[field] = cloneJson(current[field]);
    else delete merged[field];
  }
  return merged;
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

function mergeOpenClawPlugins(
  backupPlugins: unknown,
  currentPlugins: unknown,
  previousOwnership: OpenClawImagePluginOwnership,
  freshOwnership: OpenClawImagePluginOwnership,
): Record<string, unknown> | undefined {
  if (!isPlainJsonObject(backupPlugins) && !isPlainJsonObject(currentPlugins)) return undefined;
  const backup = isPlainJsonObject(backupPlugins) ? backupPlugins : {};
  const current = isPlainJsonObject(currentPlugins) ? currentPlugins : {};
  const merged = mergeJsonObjects(current, backup);
  // OpenClaw injects install records only into transient command snapshots. Its
  // durable ledger is separate, so never write this synthetic map to openclaw.json.
  delete merged.installs;
  const entries = mergeOpenClawEntryMap(backup.entries, current.entries, previousOwnership.ids);
  if (entries) merged.entries = entries;
  else delete merged.entries;

  const currentAllow = stringArray(current.allow);
  const currentDeny = stringArray(current.deny);
  const removedIds = removedImagePluginIds(previousOwnership, freshOwnership);
  const backupAllowOwnedIds = currentAllow ? previousOwnership.ids : removedIds;
  const backupDenyOwnedIds = currentDeny ? previousOwnership.ids : removedIds;
  const allow = mergeOpenClawPluginIdList(
    backup.allow,
    current.allow,
    backupAllowOwnedIds,
    new Set(currentDeny ?? []),
  );
  if (allow && allow.length > 0) merged.allow = allow;
  else delete merged.allow;
  const deny = mergeOpenClawPluginIdList(
    backup.deny,
    current.deny,
    backupDenyOwnedIds,
    new Set(currentAllow ?? []),
  );
  if (deny && deny.length > 0) merged.deny = deny;
  else delete merged.deny;

  const slots = mergeOpenClawPluginSlots(backup.slots, current.slots, previousOwnership.ids);
  if (slots) merged.slots = slots;
  else delete merged.slots;

  const load = mergeOpenClawPluginLoad(backup.load, current.load, previousOwnership.loadPaths);
  if (load) merged.load = load;
  else delete merged.load;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export interface OpenClawConfigMergeOptions {
  freshImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
  previousImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
}

export function mergeOpenClawRestoredConfig(
  backedUpConfig: unknown,
  currentConfig: unknown,
  options: OpenClawConfigMergeOptions = {},
): unknown {
  if (!isPlainJsonObject(backedUpConfig) || !isPlainJsonObject(currentConfig)) {
    throw new Error("OpenClaw selective config merge requires JSON objects");
  }

  if (
    (options.previousImagePluginInstalls === undefined) !==
    (options.freshImagePluginInstalls === undefined)
  ) {
    throw new Error("Complete previous and fresh OpenClaw image plugin provenance is required");
  }
  const previousOwnership = imagePluginOwnership(options.previousImagePluginInstalls);
  const freshOwnership = imagePluginOwnership(options.freshImagePluginInstalls);
  const merged = mergeJsonObjects(currentConfig, backedUpConfig);

  for (const key of OPENCLAW_CONFIG_RESTORE_OWNERSHIP.runtimeSections) {
    if (key in currentConfig) merged[key] = cloneJson(currentConfig[key]);
    else delete merged[key];
  }

  merged.channels = mergeOpenClawChannels(
    backedUpConfig.channels,
    currentConfig.channels,
    previousOwnership.ids,
  );
  merged.models = mergeOpenClawModels(backedUpConfig.models, currentConfig.models);
  merged.plugins = mergeOpenClawPlugins(
    backedUpConfig.plugins,
    currentConfig.plugins,
    previousOwnership,
    freshOwnership,
  );
  merged.tools = mergeOpenClawTools(backedUpConfig.tools, currentConfig.tools);

  return merged;
}
