// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { ManifestRecord } from "./definition-types";

export const SKILL_NAME_TOKEN = "{name}";
export const SKILL_SOURCE_TOKEN = "{source}";

export interface AgentSkillIntegration {
  readonly writableRoot: string;
  readonly listCommand: readonly string[];
  readonly addCommand: readonly string[] | null;
  readonly removeCommand: readonly string[] | null;
}

function readCommand(
  record: ManifestRecord,
  key: string,
  requiredToken: string | null,
): readonly string[] | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (argument) =>
        typeof argument !== "string" || argument.length === 0 || /[\u0000\r\n]/u.test(argument),
    )
  ) {
    throw new Error(`Agent manifest skills.${key} must be a non-empty string argv array`);
  }
  const command = value as string[];
  for (const token of [SKILL_NAME_TOKEN, SKILL_SOURCE_TOKEN]) {
    const count = command.filter((argument) => argument === token).length;
    if (count !== Number(requiredToken === token)) {
      throw new Error(
        `Agent manifest skills.${key} must contain ${requiredToken === token ? "exactly one" : "no"} ${token} token`,
      );
    }
  }
  return Object.freeze([...command]);
}

/** Read static skill integration metadata; no installed-skill state is accepted. */
export function readAgentSkillIntegration(raw: ManifestRecord): AgentSkillIntegration | null {
  const value = raw.skills;
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    throw new Error("Agent manifest skills must be a mapping");
  }
  const record = value as ManifestRecord;
  const allowedKeys = new Set(["writable_root", "list_command", "add_command", "remove_command"]);
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Agent manifest skills contains unsupported fields: ${unexpected.join(", ")}`);
  }

  const writableRoot = record.writable_root;
  if (
    typeof writableRoot !== "string" ||
    writableRoot !== path.posix.normalize(writableRoot) ||
    !writableRoot.startsWith("/sandbox/") ||
    writableRoot.endsWith("/") ||
    /[\u0000\r\n]/u.test(writableRoot) ||
    writableRoot
      .slice("/sandbox/".length)
      .split("/")
      .some((part) => !/^[A-Za-z0-9._-]+$/u.test(part) || part === "." || part === "..")
  ) {
    throw new Error("Agent manifest skills.writable_root must be a canonical /sandbox path");
  }

  const listCommand = readCommand(record, "list_command", null);
  if (!listCommand) throw new Error("Agent manifest skills.list_command is required");
  return Object.freeze({
    writableRoot,
    listCommand,
    addCommand: readCommand(record, "add_command", SKILL_SOURCE_TOKEN),
    removeCommand: readCommand(record, "remove_command", SKILL_NAME_TOKEN),
  });
}

export function renderAgentSkillCommand(
  binary: string,
  command: readonly string[],
  replacements: Readonly<{ name?: string; source?: string }> = {},
): string[] {
  if (!path.posix.isAbsolute(binary)) throw new Error("Agent skill binary must be absolute");
  return [
    binary,
    ...command.map((argument) => {
      if (argument === SKILL_NAME_TOKEN) {
        if (!replacements.name) throw new Error("Agent skill command requires a name");
        return replacements.name;
      }
      if (argument === SKILL_SOURCE_TOKEN) {
        if (!replacements.source) throw new Error("Agent skill command requires a source");
        return replacements.source;
      }
      return argument;
    }),
  ];
}
