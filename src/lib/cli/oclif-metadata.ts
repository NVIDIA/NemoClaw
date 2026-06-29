// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

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

function isGeneratingMetadataManifest(): boolean {
  return process.env.OCLIF_METADATA_MANIFEST_GENERATION === "1";
}

function loadGeneratedOclifMetadata(): Record<string, OclifCommandMetadata> {
  if (cachedMetadata) return cachedMetadata;

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
  return loadGeneratedOclifMetadata();
}

export function getRegisteredOclifCommandMetadata(commandId: string): OclifCommandMetadata | null {
  return getRegisteredOclifCommandsMetadata()[commandId] ?? null;
}

export function getRegisteredOclifCommandSummary(commandId: string): string | null {
  return getRegisteredOclifCommandMetadata(commandId)?.summary ?? null;
}
