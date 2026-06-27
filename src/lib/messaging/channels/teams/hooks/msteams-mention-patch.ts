// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TEAMS_MSTEAMS_MENTION_PATCH_HOOK_HANDLER_ID = "teams.msteamsMentionPatch";

export type TeamsMentionPatchEnv = Record<string, string | undefined>;

export class TeamsMSTeamsMentionPatchError extends Error {}

export function patchInstalledOpenClawMSTeamsMentions(
  env: TeamsMentionPatchEnv = process.env,
): string {
  const runtimeFile = findInstalledOpenClawMSTeamsRuntimeFile(env);
  const source = readFileSync(runtimeFile, "utf-8");
  const result = patchMSTeamsMentionEntitiesInSource(source, runtimeFile);
  if (result.status === "no-match") {
    throw new TeamsMSTeamsMentionPatchError(result.error);
  }
  if (result.status === "would-apply") {
    writeFileSync(runtimeFile, result.nextSource);
  }
  return runtimeFile;
}

export function patchMSTeamsMentionEntitiesInSource(
  source: string,
  fileLabel = "msteams runtime",
): {
  readonly nextSource: string;
  readonly status: "already-applied" | "would-apply" | "no-match";
  readonly error?: string;
} {
  if (source.includes("nemoclaw: accept Teams spaced AAD mentions")) {
    return { nextSource: source, status: "already-applied" };
  }
  if (hasSpacedTeamsMentionPattern(source)) {
    return { nextSource: source, status: "already-applied" };
  }

  const original = [
    "function parseMentions(text) {",
    "\tconst mentionPattern = /@\\[([^\\]]+)\\]\\(([^)]+)\\)/g;",
    "\tconst entities = [];",
    "\treturn {",
    "\t\ttext: text.replace(mentionPattern, (match, name, id) => {",
    "\t\t\tconst trimmedId = id.trim();",
    "\t\t\tif (!isValidTeamsId(trimmedId)) return match;",
    "\t\t\tconst trimmedName = name.trim();",
    "\t\t\tconst mentionTag = `<at>${trimmedName}</at>`;",
    "\t\t\tentities.push({",
    '\t\t\t\ttype: "mention",',
    "\t\t\t\ttext: mentionTag,",
    "\t\t\t\tmentioned: {",
    "\t\t\t\t\tid: trimmedId,",
    "\t\t\t\t\tname: trimmedName",
    "\t\t\t\t}",
    "\t\t\t});",
    "\t\t\treturn mentionTag;",
    "\t\t}),",
    "\t\tentities",
    "\t};",
    "}",
  ].join("\n");
  if (!source.includes(original)) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw msteams mention parser shape not recognized in ${fileLabel}`,
    };
  }

  const replacement = [
    "function parseMentions(text) {",
    "\tconst mentionPattern = /@\\[([^\\]]+)\\]\\s*\\(([^)]+)\\)/g;",
    "\tconst entities = [];",
    "\treturn {",
    "\t\ttext: text.replace(mentionPattern, (match, name, id) => {",
    "\t\t\tconst trimmedId = id.trim();",
    "\t\t\tif (!isValidTeamsId(trimmedId)) return match;",
    "\t\t\tconst trimmedName = name.trim();",
    "\t\t\tconst mentionTag = `<at>${trimmedName}</at>`;",
    "\t\t\tentities.push({",
    '\t\t\t\ttype: "mention",',
    "\t\t\t\ttext: mentionTag,",
    "\t\t\t\tmentioned: {",
    "\t\t\t\t\tid: trimmedId,",
    "\t\t\t\t\tname: trimmedName",
    "\t\t\t\t}",
    "\t\t\t});",
    "\t\t\treturn mentionTag;",
    "\t\t}),",
    "\t\tentities",
    "\t}; // nemoclaw: accept Teams spaced AAD mentions (#5852)",
    "}",
  ].join("\n");

  return {
    nextSource: source.replace(original, replacement),
    status: "would-apply",
  };
}

function hasSpacedTeamsMentionPattern(source: string): boolean {
  return source.split(/\r?\n/).some(
    (line) =>
      /\bmentionPattern\s*=/.test(line) &&
      line.includes("@\\[") &&
      line.includes("\\]\\s*\\(") &&
      line.includes("/g"),
  );
}

function findInstalledOpenClawMSTeamsRuntimeFile(env: TeamsMentionPatchEnv): string {
  const roots = msteamsPluginSearchRoots(env);
  const matches: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of listJsFilesRecursive(root, 8)) {
      const source = readFileSync(file, "utf-8");
      if (
        source.includes("function parseMentions(text)") &&
        source.includes("function buildActivity(msg")
      ) {
        matches.push(file);
      }
    }
  }
  if (matches.length !== 1) {
    throw new TeamsMSTeamsMentionPatchError(
      `Expected exactly one installed OpenClaw msteams runtime file, found ${matches.length}`,
    );
  }
  return matches[0];
}

function msteamsPluginSearchRoots(env: TeamsMentionPatchEnv): readonly string[] {
  const configuredRoot = sanitizeOptionalString(env.NEMOCLAW_MSTEAMS_PLUGIN_ROOT);
  if (configuredRoot) return [configuredRoot];
  const home = sanitizeOptionalString(env.HOME) || homedir();
  return [join(home, ".openclaw", "extensions")];
}

function listJsFilesRecursive(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const stats = statSync(fullPath);
      if (stats.size > 512 * 1024) continue;
      out.push(fullPath);
    }
  };
  visit(root, 0);
  return out;
}

function sanitizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
