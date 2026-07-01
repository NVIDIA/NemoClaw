// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { MessagingChannelModule, MessagingChannelValidationIssue } from "./module";
import { isMessagingChannelModule, validateMessagingChannelModule } from "./module";

export interface MessagingChannelModuleDiscoveryEntry {
  readonly id: string;
  readonly source?: string;
  load(): unknown;
}

export interface MessagingChannelModuleDiscoveryOptions {
  readonly order?: readonly string[];
}

export interface MessagingChannelDirectoryDiscoveryOptions
  extends MessagingChannelModuleDiscoveryOptions {
  readonly entrypoint?: string;
  readonly loadModule?: (entrypoint: string) => unknown;
  readonly readChannelDirectories?: (channelRoot: string) => readonly string[];
}

export interface MessagingChannelModuleDiscoveryIssue extends MessagingChannelValidationIssue {
  readonly channelId?: string;
  readonly source?: string;
}

export interface MessagingChannelModuleDiscoveryResult {
  readonly modules: readonly MessagingChannelModule[];
  readonly issues: readonly MessagingChannelModuleDiscoveryIssue[];
}

export function discoverMessagingChannelModules(
  entries: readonly MessagingChannelModuleDiscoveryEntry[],
  options: MessagingChannelModuleDiscoveryOptions = {},
): MessagingChannelModuleDiscoveryResult {
  const issues: MessagingChannelModuleDiscoveryIssue[] = [];
  const modules: MessagingChannelModule[] = [];

  for (const entry of entries) {
    const loaded = loadDiscoveryEntry(entry, issues);
    if (loaded === null) continue;
    const extracted = extractMessagingChannelModule(loaded);
    if (extracted.length === 0) {
      issues.push(
        discoveryError(
          entry,
          "moduleExport",
          `Messaging channel '${entry.id}' must export a MessagingChannelModule from its entrypoint.`,
        ),
      );
      continue;
    }
    if (extracted.length > 1) {
      issues.push(
        discoveryError(
          entry,
          "moduleExport",
          `Messaging channel '${entry.id}' entrypoint exported multiple channel modules; export exactly one.`,
        ),
      );
      continue;
    }

    const [module] = extracted;
    for (const issue of validateMessagingChannelModule(module)) {
      issues.push({ ...issue, channelId: module.id, source: entry.source });
    }
    modules.push(module);
  }

  for (const issue of duplicateModuleIssues(modules)) issues.push(issue);
  return {
    modules: sortDiscoveredModules(modules, options.order),
    issues,
  };
}

export function discoverMessagingChannelModulesFromDirectory(
  channelRoot: string,
  options: MessagingChannelDirectoryDiscoveryOptions = {},
): MessagingChannelModuleDiscoveryResult {
  const readChannelDirectories = options.readChannelDirectories ?? defaultReadChannelDirectories;
  const loadModule = options.loadModule ?? defaultLoadModule;
  const entrypoint = options.entrypoint ?? "index";
  const entries = readChannelDirectories(channelRoot).map((id) => ({
    id,
    source: path.join(channelRoot, id),
    load: () => loadModule(path.join(channelRoot, id, entrypoint)),
  }));
  return discoverMessagingChannelModules(entries, options);
}

export function assertMessagingChannelDiscovery(
  result: MessagingChannelModuleDiscoveryResult,
): readonly MessagingChannelModule[] {
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      [
        "Messaging channel discovery failed.",
        ...errors.map((issue) => {
          const source = issue.source ? ` (${issue.source})` : "";
          return `  - ${issue.message}${source}`;
        }),
      ].join("\n"),
    );
  }
  return result.modules;
}

function loadDiscoveryEntry(
  entry: MessagingChannelModuleDiscoveryEntry,
  issues: MessagingChannelModuleDiscoveryIssue[],
): unknown | null {
  try {
    return entry.load();
  } catch (cause) {
    issues.push(
      discoveryError(
        entry,
        "moduleLoad",
        `Messaging channel '${entry.id}' failed to load: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      ),
    );
    return null;
  }
}

function defaultReadChannelDirectories(channelRoot: string): readonly string[] {
  return fs
    .readdirSync(channelRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function defaultLoadModule(entrypoint: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(entrypoint);
}

function extractMessagingChannelModule(value: unknown): MessagingChannelModule[] {
  if (isMessagingChannelModule(value)) return [value];
  if (!value || typeof value !== "object") return [];
  const exports = value as Record<string, unknown>;
  const modules = uniqueModules(Object.values(exports).filter(isMessagingChannelModule));
  if (modules.length > 0) return modules;
  return isMessagingChannelModule(exports.default) ? [exports.default] : [];
}

function uniqueModules(modules: readonly MessagingChannelModule[]): MessagingChannelModule[] {
  return Array.from(new Set(modules));
}

function duplicateModuleIssues(
  modules: readonly MessagingChannelModule[],
): MessagingChannelModuleDiscoveryIssue[] {
  const seen = new Map<string, MessagingChannelModule>();
  const issues: MessagingChannelModuleDiscoveryIssue[] = [];
  for (const module of modules) {
    const duplicate = seen.get(module.id);
    if (duplicate) {
      issues.push({
        severity: "error",
        code: "duplicateModule",
        channelId: module.id,
        message: `Duplicate messaging channel module id '${module.id}'.`,
      });
      continue;
    }
    seen.set(module.id, module);
  }
  return issues;
}

function sortDiscoveredModules(
  modules: readonly MessagingChannelModule[],
  order: readonly string[] | undefined,
): readonly MessagingChannelModule[] {
  const orderIndex = new Map((order ?? []).map((id, index) => [id, index]));
  return [...modules].sort((left, right) => {
    const leftIndex = orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.id.localeCompare(right.id);
  });
}

function discoveryError(
  entry: MessagingChannelModuleDiscoveryEntry,
  code: string,
  message: string,
): MessagingChannelModuleDiscoveryIssue {
  return {
    severity: "error",
    code,
    channelId: entry.id,
    source: entry.source,
    message,
  };
}
