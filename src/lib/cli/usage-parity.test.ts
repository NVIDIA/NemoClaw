// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
  if (!match) throw new Error(`No literal static usage in ${commandId}`);
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

describe("public display usage parity", () => {
  it("documents every usage flag of each root-help row", () => {
    const drifted: string[] = [];
    for (const [commandId, entries] of Object.entries(PUBLIC_DISPLAY_ENTRIES)) {
      if (USAGE_NOT_IN_COMMAND_SOURCE.has(commandId)) continue;
      for (const entry of entries) {
        if (entry.hidden && !HIDDEN_COMMAND_IDS_WITH_PARITY.has(commandId)) continue;
        const missing = missingUsageFlags(commandId, entry.flags);
        if (missing.length > 0) {
          drifted.push(`${commandId} (${entry.usage}) is missing ${missing.join(", ")}`);
        }
      }
    }
    expect(drifted).toEqual([]);
  });

  it("documents every usage flag in the usage hints printed for missing arguments", () => {
    const source = fs.readFileSync(POLICY_CHANNEL_SOURCE, "utf8");
    const hints = [
      ...source.matchAll(/const usage = `\$\{CLI_NAME\} <sandbox> ([^`]+)`/gu),
      ...source.matchAll(/Usage: \$\{CLI_NAME\} <sandbox> ([^`]+)`/gu),
    ].map((match) => match[1]);
    expect(hints.length).toBeGreaterThan(0);

    const drifted: string[] = [];
    for (const hint of hints) {
      const [topic, subcommandToken] = hint.split(" ");
      if (!topic || !subcommandToken) {
        drifted.push(`usage hint does not name a command: '${hint}'`);
        continue;
      }
      const subcommands = subcommandToken === "${verb}" ? ["start", "stop"] : [subcommandToken];
      for (const subcommand of subcommands) {
        const commandId = `sandbox:${topic}:${subcommand}`;
        const missing = missingUsageFlags(commandId, hint);
        if (missing.length > 0) {
          drifted.push(`${commandId} hint '${hint}' is missing ${missing.join(", ")}`);
        }
      }
    }
    expect(drifted).toEqual([]);
  });
});
