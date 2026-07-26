// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { CLI_DISPLAY_NAME } from "./branding";
import type { PublicCommandDisplayEntry } from "./command-display";

const GENERATED_METADATA_FILE = "oclif-command-metadata.generated.json";

export type OclifCommandMetadata = {
  args?: Record<string, unknown>;
  baseFlags?: Record<string, unknown>;
  description?: string;
  deprecationOptions?: unknown;
  examples?: string[];
  flags?: Record<string, unknown>;
  hidden?: boolean;
  id?: string;
  /** Public sandbox-first help/listing metadata for `nemoclaw <name> action` grammar. */
  publicDisplay?: readonly PublicCommandDisplayEntry[];
  state?: string;
  strict?: boolean;
  summary?: string;
  usage?: string[];
};

function packageRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

function generatedMetadataPath(): string {
  return path.join(packageRoot(), "dist", "lib", "cli", GENERATED_METADATA_FILE);
}

let cachedMetadata: Record<string, OclifCommandMetadata> | null = null;

function commandIdFromSourceFile(relativeFile: string): string {
  const parsed = path.parse(relativeFile);
  const topics = parsed.dir.split(path.sep).filter(Boolean);
  const command = parsed.name === "index" ? null : parsed.name;
  return [...topics, command].filter(Boolean).join(":");
}

function* walkSourceCommandFiles(dir: string, prefix = ""): Generator<string> {
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceCommandFiles(absolute, relative);
    } else if (
      entry.isFile() &&
      /\.(?:[cm]?ts|tsx)$/.test(entry.name) &&
      !/\.(?:d|test|spec)\.(?:[cm]?ts|tsx)$/.test(entry.name)
    ) {
      yield relative;
    }
  }
}

// Source tests need routing metadata before command modules can load. Read only
// recognized literal/branding statics so discovery cannot execute a command or
// re-enter this registry.
function staticJsonString(source: string, property: "summary"): string | undefined {
  const match = source.match(
    new RegExp(`\\bstatic\\s+(?:readonly\\s+)?${property}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*;`),
  );
  if (!match?.[1]) return undefined;
  return JSON.parse(match[1]) as string;
}

function staticSummary(source: string): string | undefined {
  const literalSummary = staticJsonString(source, "summary");
  if (literalSummary !== undefined) return literalSummary;

  const brandedTemplate = source.match(
    /\bstatic\s+(?:readonly\s+)?summary\s*=\s*`([^`$\\]*)\$\{CLI_DISPLAY_NAME\}([^`$\\]*)`\s*;/,
  );
  if (!brandedTemplate) return undefined;
  return `${brandedTemplate[1]}${CLI_DISPLAY_NAME}${brandedTemplate[2]}`;
}

function staticBoolean(source: string, property: "hidden" | "strict"): boolean | undefined {
  const match = source.match(
    new RegExp(`\\bstatic\\s+(?:readonly\\s+)?${property}\\s*=\\s*(true|false)\\s*;`),
  );
  return match?.[1] === undefined ? undefined : match[1] === "true";
}

function sourceCommandsRoot(): string | null {
  const root = packageRoot();
  const sourceCliDir = path.join(root, "src", "lib", "cli");
  // A compiled module must always use the generated package manifest below.
  return path.resolve(__dirname) === sourceCliDir ? path.join(root, "src", "commands") : null;
}

function loadSourceOclifMetadata(commandRoot: string): Record<string, OclifCommandMetadata> {
  const metadata: Record<string, OclifCommandMetadata> = {};
  for (const relativeFile of walkSourceCommandFiles(commandRoot)) {
    const source = fs.readFileSync(path.join(commandRoot, relativeFile), "utf-8");
    const commandId = commandIdFromSourceFile(relativeFile);
    const commandMetadata: OclifCommandMetadata = { id: commandId };
    const summary = staticSummary(source);
    const hidden = staticBoolean(source, "hidden");
    const strict = staticBoolean(source, "strict");
    if (summary !== undefined) commandMetadata.summary = summary;
    if (hidden !== undefined) commandMetadata.hidden = hidden;
    if (strict !== undefined) commandMetadata.strict = strict;
    if (metadata[commandId]) throw new Error(`Duplicate source oclif command ID: ${commandId}`);
    metadata[commandId] = commandMetadata;
  }
  return metadata;
}

function isGeneratingMetadataManifest(): boolean {
  return process.env.OCLIF_METADATA_MANIFEST_GENERATION === "1";
}

function loadOclifMetadata(): Record<string, OclifCommandMetadata> {
  if (cachedMetadata) return cachedMetadata;

  const commandRoot = sourceCommandsRoot();
  if (commandRoot) {
    cachedMetadata = loadSourceOclifMetadata(commandRoot);
    return cachedMetadata;
  }

  const metadataPath = generatedMetadataPath();
  if (!fs.existsSync(metadataPath) && isGeneratingMetadataManifest()) return {};
  if (!fs.existsSync(metadataPath)) {
    throw new Error(
      `Missing generated oclif metadata manifest at ${metadataPath}. Run npm run build:cli before invoking CLI metadata consumers.`,
    );
  }

  cachedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<
    string,
    OclifCommandMetadata
  >;
  return cachedMetadata;
}

export function getRegisteredOclifCommandsMetadata(): Record<string, OclifCommandMetadata> {
  return loadOclifMetadata();
}

export function getRegisteredOclifCommandMetadata(commandId: string): OclifCommandMetadata | null {
  return getRegisteredOclifCommandsMetadata()[commandId] ?? null;
}

export function getRegisteredOclifCommandSummary(commandId: string): string | null {
  return getRegisteredOclifCommandMetadata(commandId)?.summary ?? null;
}
