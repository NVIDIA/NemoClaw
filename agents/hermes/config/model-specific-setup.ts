// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KNOWN_MODEL_SETUP_AGENTS = new Set(["openclaw", "hermes"]);

const MODEL_SETUP_EFFECT_KEYS: Record<string, Set<string>> = {
  openclaw: new Set(["openclawCompat", "openclawPlugins"]),
  hermes: new Set(["hermesCompat"]),
};

export type ModelSetupAgent = "hermes";

export type ModelSetupManifest = {
  id: string;
  agent: string;
  description: string;
  match: {
    modelIds?: string[];
    providerKey?: string;
    inferenceApi?: string;
    baseUrl?: string;
  };
  effects: Record<string, unknown>;
};

export type ModelSetupContext = {
  model: string;
  providerKey: string;
  inferenceApi: string;
  baseUrl: string;
};

export type ModelSetupDiscoveryOptions = {
  env: NodeJS.ProcessEnv;
  scriptDir: string;
};

export function discoverModelSpecificSetups(
  agent: ModelSetupAgent,
  context: ModelSetupContext,
  opts: ModelSetupDiscoveryOptions,
): ModelSetupManifest[] {
  const registryRoot = findRegistryRoot(opts);
  if (!registryRoot) return [];

  const manifests: ModelSetupManifest[] = [];
  for (const manifestPath of listJsonFiles(registryRoot)) {
    if (manifestPath.endsWith("/schema.json")) continue;
    const payload = validateManifestPayload(
      JSON.parse(readFileSync(manifestPath, "utf-8")),
      manifestPath,
    );
    if (payload.agent !== agent) continue;
    validateSelectedAgentEffects(payload, manifestPath);
    if (modelSetupMatches(payload, context)) {
      manifests.push(payload);
    }
  }
  return manifests;
}

function findRegistryRoot(opts: ModelSetupDiscoveryOptions): string | null {
  const explicit = opts.env.NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR;
  if (explicit) {
    if (!existsSync(explicit) || !statSync(explicit).isDirectory()) {
      throw new Error(
        `NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR must point to an existing directory: ${explicit}`,
      );
    }
    return explicit;
  }

  const roots = [
    "/opt/nemoclaw-blueprint/model-specific-setup",
    "/sandbox/.nemoclaw/blueprints/0.1.0/model-specific-setup",
    join(opts.scriptDir, "..", "..", "nemoclaw-blueprint", "model-specific-setup"),
    join(process.cwd(), "nemoclaw-blueprint", "model-specific-setup"),
  ].filter((entry): entry is string => Boolean(entry));

  for (const root of [...new Set(roots)]) {
    if (existsSync(root) && statSync(root).isDirectory()) return root;
  }
  return null;
}

function listJsonFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function validateManifestPayload(payload: unknown, manifestPath: string): ModelSetupManifest {
  if (!isRecord(payload)) {
    throw new Error(`${manifestPath}: manifest must be a JSON object`);
  }
  if (!isNonEmptyString(payload.id)) {
    throw new Error(`${manifestPath}: field 'id' must be a non-empty string`);
  }
  if (!isNonEmptyString(payload.agent)) {
    throw new Error(`${manifestPath}: field 'agent' is required`);
  }
  if (!KNOWN_MODEL_SETUP_AGENTS.has(payload.agent)) {
    throw new Error(`${manifestPath}: unknown agent '${payload.agent}'`);
  }
  if (!isNonEmptyString(payload.description)) {
    throw new Error(`${manifestPath}: field 'description' must be a non-empty string`);
  }
  if (!isRecord(payload.match)) {
    throw new Error(`${manifestPath}: field 'match' must be an object`);
  }
  validateMatch(payload.match, manifestPath);
  if (!isRecord(payload.effects) || Object.keys(payload.effects).length === 0) {
    throw new Error(`${manifestPath}: field 'effects' must be a non-empty object`);
  }
  return payload as ModelSetupManifest;
}

function validateMatch(match: Record<string, unknown>, manifestPath: string): void {
  if (Object.keys(match).length === 0) {
    throw new Error(`${manifestPath}: field 'match' must be a non-empty object`);
  }

  const allowedKeys = new Set(["modelIds", "providerKey", "inferenceApi", "baseUrl"]);
  const unknownKeys = Object.keys(match).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${manifestPath}: unknown match keys: ${unknownKeys.join(", ")}`);
  }

  if (
    match.modelIds !== undefined &&
    (!Array.isArray(match.modelIds) ||
      match.modelIds.length === 0 ||
      !match.modelIds.every(isNonEmptyString))
  ) {
    throw new Error(`${manifestPath}: match.modelIds must be a non-empty string array`);
  }
  for (const key of ["providerKey", "inferenceApi", "baseUrl"]) {
    const value = match[key];
    if (value !== undefined && !isNonEmptyString(value)) {
      throw new Error(`${manifestPath}: match.${key} must be a non-empty string`);
    }
  }
}

function validateSelectedAgentEffects(payload: ModelSetupManifest, manifestPath: string): void {
  const allowedEffectKeys = MODEL_SETUP_EFFECT_KEYS[payload.agent];
  const unknownEffectKeys = Object.keys(payload.effects).filter(
    (key) => !allowedEffectKeys.has(key),
  );
  if (unknownEffectKeys.length > 0) {
    throw new Error(
      `${manifestPath}: unknown effects for agent '${payload.agent}': ${
        unknownEffectKeys.join(", ")
      }`,
    );
  }

  if (payload.agent === "hermes") {
    const compat = payload.effects.hermesCompat;
    if (compat !== undefined && !isRecord(compat)) {
      throw new Error(`${manifestPath}: effects.hermesCompat must be an object`);
    }
  }
}

function modelSetupMatches(payload: ModelSetupManifest, context: ModelSetupContext): boolean {
  const match = payload.match;
  if (
    match.modelIds &&
    !new Set(match.modelIds.map((modelId) => modelId.trim().toLowerCase())).has(
      context.model.trim().toLowerCase(),
    )
  ) {
    return false;
  }
  if (match.providerKey && context.providerKey !== match.providerKey) return false;
  if (match.inferenceApi && context.inferenceApi !== match.inferenceApi) return false;
  if (match.baseUrl && trimTrailingSlash(context.baseUrl) !== trimTrailingSlash(match.baseUrl)) {
    return false;
  }
  return true;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
