// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { CommandDisplayEntry } from "./command-display";

export type OclifCommandMetadata = {
  args?: Record<string, unknown>;
  baseFlags?: Record<string, unknown>;
  description?: string;
  examples?: string[];
  flags?: Record<string, unknown>;
  hidden?: boolean;
  id?: string;
  strict?: boolean;
  summary?: string;
  usage?: string[];
  display?: readonly CommandDisplayEntry[];
};

type CommandExport = {
  default?: OclifCommandMetadata;
  [key: string]: unknown;
};

function packageRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

function commandIdFromDiscoveredFile(relativeFile: string): string {
  const parsed = path.parse(relativeFile);
  const topics = parsed.dir.split(path.sep).filter(Boolean);
  const command = parsed.name === "index" ? null : parsed.name;
  return [...topics, command].filter(Boolean).join(":");
}

function* walkCommandFiles(dir: string, prefix = ""): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir).sort()) {
    const absolute = path.join(dir, entry);
    const relative = path.join(prefix, entry);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      yield* walkCommandFiles(absolute, relative);
    } else if (
      stat.isFile() &&
      /\.(js|cjs|mjs|ts|tsx|mts|cts)$/.test(entry) &&
      !/\.(d|test|spec)\.(js|ts|tsx|mts|cts)$/.test(entry)
    ) {
      yield relative;
    }
  }
}

function commandClassFromModule(moduleExports: CommandExport): OclifCommandMetadata | null {
  if (moduleExports.default) return moduleExports.default;
  for (const value of Object.values(moduleExports)) {
    if (value && typeof value === "function") return value as OclifCommandMetadata;
  }
  return null;
}

function loadPatternDiscoveredCommands(): Record<string, OclifCommandMetadata> | null {
  const root = packageRoot();
  const packageJsonPath = path.join(root, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
    oclif?: { commands?: { strategy?: string; target?: string } };
  };
  const commandDiscovery = packageJson.oclif?.commands;
  if (commandDiscovery?.strategy !== "pattern" || !commandDiscovery.target) return null;

  const commandRoot = path.resolve(root, commandDiscovery.target);
  const commands: Record<string, OclifCommandMetadata> = {};
  for (const relativeFile of walkCommandFiles(commandRoot)) {
    const commandId = commandIdFromDiscoveredFile(relativeFile);
    const commandClass = commandClassFromModule(
      require(path.join(commandRoot, relativeFile)) as CommandExport,
    );
    if (commandClass) commands[commandId] = commandClass;
  }

  return Object.keys(commands).length > 0 ? commands : null;
}

function loadOclifCommands(): Record<string, OclifCommandMetadata> | null {
  return loadPatternDiscoveredCommands();
}

export function getRegisteredOclifCommandsMetadata(): Record<string, OclifCommandMetadata> {
  return loadOclifCommands() ?? {};
}

export function getRegisteredOclifCommandMetadata(
  commandId: string,
): OclifCommandMetadata | null {
  return getRegisteredOclifCommandsMetadata()[commandId] ?? null;
}

export function getRegisteredOclifCommandSummary(commandId: string): string | null {
  return getRegisteredOclifCommandMetadata(commandId)?.summary ?? null;
}
