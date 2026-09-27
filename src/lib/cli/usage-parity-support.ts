// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { PUBLIC_DISPLAY_ENTRIES } from "./public-display-defaults";

const COMMANDS_ROOT = path.join(process.cwd(), "src", "commands");
const POLICY_CHANNEL_SOURCE = path.join(
  process.cwd(),
  "src",
  "lib",
  "actions",
  "sandbox",
  "policy-channel.ts",
);

/** These commands set `static usage` from an imported constant, not a source literal. */
const USAGE_NOT_IN_COMMAND_SOURCE = new Set(["onboard", "root:help", "root:version"]);
/** Identified usage drift on a currently hidden row; keep it in parity so unhiding stays safe. */
const HIDDEN_COMMAND_IDS_WITH_PARITY = new Set(["sandbox:inference:set"]);

const FLAG_TOKEN_PATTERN = /(?:^|[\s[(,|])(--?[a-zA-Z][\w-]*)/gu;

function commandSourcePath(commandId: string): string {
  return path.join(COMMANDS_ROOT, `${commandId.replace(/:/gu, path.sep)}.ts`);
}

function staticUsage(commandId: string): string[] {
  const source = fs.readFileSync(commandSourcePath(commandId), "utf8");
  const match = /static usage = (\[[\s\S]*?\]);/u.exec(source);
  if (match === null) throw new Error(`No literal static usage in ${commandId}`);
  const parsed: unknown = JSON.parse(match[1].replace(/,\s*\]/u, "]"));
  if (!Array.isArray(parsed)) throw new Error(`static usage for ${commandId} is not an array`);
  return parsed.map(String);
}

function flagTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(FLAG_TOKEN_PATTERN)) tokens.add(match[1].toLowerCase());
  return [...tokens].sort();
}

function missingUsageFlags(commandId: string, documentedFlags: string | undefined): string[] {
  const documented = new Set(flagTokens(documentedFlags ?? ""));
  return flagTokens(staticUsage(commandId).join(" ")).filter((token) => !documented.has(token));
}

function visibleEntries() {
  return Object.entries(PUBLIC_DISPLAY_ENTRIES)
    .filter(([commandId]) => !USAGE_NOT_IN_COMMAND_SOURCE.has(commandId))
    .flatMap(([commandId, entries]) =>
      entries
        .filter((entry) => !entry.hidden || HIDDEN_COMMAND_IDS_WITH_PARITY.has(commandId))
        .map((entry) => ({ commandId, usage: entry.usage, flags: entry.flags })),
    );
}

function parseUsageHints() {
  const source = fs.readFileSync(POLICY_CHANNEL_SOURCE, "utf8");
  const hints: string[] = [
    ...source.matchAll(/const usage = `\$\{CLI_NAME\} <sandbox> ([^`]+)`/gu),
    ...source.matchAll(/Usage: \$\{CLI_NAME\} <sandbox> ([^`]+)`/gu),
  ].map((match) => match[1]);
  return hints.flatMap((hint) => {
    const [topic, subcommandToken] = hint.split(" ");
    if (topic === undefined || subcommandToken === undefined) return [];
    const subcommands = subcommandToken === "${verb}" ? ["start", "stop"] : [subcommandToken];
    return subcommands.map((subcommand) => ({ commandId: `sandbox:${topic}:${subcommand}`, hint }));
  });
}

export { visibleEntries, parseUsageHints, missingUsageFlags };
