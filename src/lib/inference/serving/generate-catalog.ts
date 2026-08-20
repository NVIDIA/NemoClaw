// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { resolveSourceBuildIdentity } from "../../core/version";
import { getManagedInferenceServingCatalogRegistries } from "./adapter-registry";
import { compileTrustedServingCatalog, serializeCompiledServingCatalog } from "./catalog";
import type {
  ServingCatalogRegistries,
  ServingCatalogSchemas,
  ServingCatalogSource,
} from "./types";

function readJson(path: string): object {
  return JSON.parse(readFileSync(path, "utf8")) as object;
}

function loadSchemas(rootDir: string): ServingCatalogSchemas {
  const schemaRoot = join(rootDir, "managed-inference", "schemas");
  return {
    catalog: readJson(join(schemaRoot, "catalog.schema.json")),
    model: readJson(join(schemaRoot, "model.schema.json")),
    preset: readJson(join(schemaRoot, "preset.schema.json")),
    recipe: readJson(join(schemaRoot, "recipe.schema.json")),
  };
}

function discoverYamlFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discoverYamlFiles(path);
    return entry.isFile() && /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

function loadSources(rootDir: string): ServingCatalogSource[] {
  const managedInferenceRoot = join(rootDir, "managed-inference");
  const files = [
    ...discoverYamlFiles(join(managedInferenceRoot, "models")),
    ...discoverYamlFiles(join(managedInferenceRoot, "recipes")),
    ...discoverYamlFiles(join(managedInferenceRoot, "presets")),
  ];
  return files
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((path) => ({
      path: relative(rootDir, path).replaceAll("\\", "/"),
      contents: readFileSync(path, "utf8"),
    }));
}

export interface GenerateServingCatalogOptions {
  rootDir: string;
  outputPath?: string;
  registries?: ServingCatalogRegistries;
}

function compileServingCatalog(options: GenerateServingCatalogOptions) {
  return compileTrustedServingCatalog({
    sources: loadSources(options.rootDir),
    sourceRevision: resolveSourceBuildIdentity({ rootDir: options.rootDir }).sourceRevision,
    schemas: loadSchemas(options.rootDir),
    registries: options.registries ?? getManagedInferenceServingCatalogRegistries(),
  });
}

export function checkServingCatalog(options: GenerateServingCatalogOptions): void {
  compileServingCatalog(options);
}

export function generateServingCatalog(options: GenerateServingCatalogOptions): string {
  const outputPath =
    options.outputPath ?? join(options.rootDir, "dist", "managed-inference", "catalog.json");
  const catalog = compileServingCatalog(options);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeCompiledServingCatalog(catalog));
  return outputPath;
}

if (require.main === module) {
  const rootDir = join(__dirname, "..", "..", "..", "..");
  if (process.argv.includes("--check")) checkServingCatalog({ rootDir });
  else generateServingCatalog({ rootDir });
}
