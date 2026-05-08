// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public command display registry derived from oclif command metadata.
 *
 * The command entries shown in root help, docs checks, and legacy dispatch
 * helpers are colocated with the oclif command entrypoints under
 * `src/commands/**` via `withCommandDisplay(...)`. This module projects that
 * metadata into the historical `CommandDef` shape while command discovery
 * itself stays owned by oclif.
 *
 * Usage strings use "nemoclaw" as a canonical placeholder. The exported
 * {@link brandedUsage} helper replaces it with the active CLI_NAME
 * (e.g. "nemohermes") for display.
 */

import { CLI_NAME } from "./branding";
import type { CommandDisplayEntry, CommandGroup } from "./command-display";
import { getRegisteredOclifCommandsMetadata } from "./oclif-metadata";

export type { CommandGroup } from "./command-display";

/** Replace the canonical "nemoclaw" prefix in a usage string with CLI_NAME. */
export function brandedUsage(usage: string): string {
  return usage.replace(/^nemoclaw/, CLI_NAME);
}

export interface CommandDef extends Omit<CommandDisplayEntry, "order"> {
  /** Registered internal oclif command ID that handles this public command shape. */
  commandId: string;
}

/** Group display order matching the current help() UX */
export const GROUP_ORDER: readonly CommandGroup[] = [
  "Getting Started",
  "Sandbox Management",
  "Skills",
  "Policy Presets",
  "Messaging Channels",
  "Compatibility Commands",
  "Services",
  "Troubleshooting",
  "Credentials",
  "Backup",
  "Upgrade",
  "Cleanup",
] as const;

type RegisteredCommandDisplayEntry = CommandDisplayEntry & { commandId: string };

function displayEntriesFromOclifMetadata(): CommandDef[] {
  const entries: RegisteredCommandDisplayEntry[] = [];
  for (const [commandId, metadata] of Object.entries(getRegisteredOclifCommandsMetadata())) {
    for (const displayEntry of metadata.display ?? []) {
      entries.push({ ...displayEntry, commandId });
    }
  }

  return entries
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...entry }) => entry);
}

/** All CLI display commands. Hidden entries are included for dispatch helpers. */
export const COMMANDS: readonly CommandDef[] = displayEntriesFromOclifMetadata();

/** All global-scope commands. */
export function globalCommands(): CommandDef[] {
  return COMMANDS.filter((c) => c.scope === "global");
}

/** All sandbox-scope commands. */
export function sandboxCommands(): CommandDef[] {
  return COMMANDS.filter((c) => c.scope === "sandbox");
}

/** Commands visible in help output and canonical list (not hidden). */
export function visibleCommands(): CommandDef[] {
  return COMMANDS.filter((c) => !c.hidden);
}

/** Visible commands grouped by CommandGroup, ordered by GROUP_ORDER.
 *  Usage strings are branded with the active CLI_NAME. */
export function commandsByGroup(): Map<CommandGroup, CommandDef[]> {
  const visible = visibleCommands();
  const grouped = new Map<CommandGroup, CommandDef[]>();
  for (const group of GROUP_ORDER) {
    const cmds = visible
      .filter((c) => c.group === group)
      .map((c) => ({
        ...c,
        usage: brandedUsage(c.usage),
        description: c.description.replace(/nemoclaw/g, CLI_NAME),
      }));
    if (cmds.length > 0) {
      grouped.set(group, cmds);
    }
  }
  return grouped;
}

/**
 * Sorted, deduplicated usage strings for visible commands.
 * This is the canonical list that check-docs.sh compares against doc headings.
 */
export function canonicalUsageList(): string[] {
  return visibleCommands()
    .map((c) => c.usage)
    .sort();
}

/**
 * First token(s) after "nemoclaw" for each global command.
 *
 * For multi-word commands like "nemoclaw tunnel start", extracts "tunnel".
 * For flag-style like "nemoclaw --help", extracts "--help".
 * For "nemoclaw onboard --from", extracts "onboard".
 */
export function globalCommandTokens(): Set<string> {
  const tokens = new Set<string>();
  for (const cmd of globalCommands()) {
    const rest = cmd.usage.replace(/^nemoclaw\s+/, "");
    const token = rest.split(/\s+/)[0];
    tokens.add(token);
  }
  return tokens;
}

/**
 * Action tokens for sandbox commands.
 *
 * For "nemoclaw <name> connect", extracts "connect".
 * Includes empty string for default connect behavior.
 */
export function sandboxActionTokens(): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const cmd of sandboxCommands()) {
    const rest = cmd.usage.replace(/^nemoclaw\s+<name>\s*/, "");
    const token = rest.split(/\s+/)[0];
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  if (!seen.has("")) {
    tokens.push("");
  }
  return tokens;
}
