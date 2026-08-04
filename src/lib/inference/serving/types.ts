// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ServingDefinitionKind = "ServingRecipe" | "ServingPreset";
export type ServingSelectionPolicy = "automatic" | "explicit-only" | "disabled";
export type ReadinessEntityKind = "observation" | "capability" | "qualification";

export interface ServingMetadata {
  id: string;
  displayName?: string;
}

export interface ServingRecipe {
  apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  kind: "ServingRecipe";
  metadata: ServingMetadata;
  spec: {
    backend: string;
    model: {
      id: string;
      revision: string;
      servedName?: string;
      files?: Array<{ path: string; digest: string }>;
    };
    runtime?: {
      image?: string;
      architecture?: "amd64" | "arm64";
      components?: Record<string, string>;
    };
    execution: {
      materializerRef: string;
      lifecycleRef: string;
    };
    serve?: {
      arguments?: Array<{ name: string; value?: string | number | boolean }>;
    };
    readiness?: {
      timeoutSeconds?: number;
      expectedModel?: string;
    };
  };
}

export interface ServingReadinessRequirement {
  readiness:
    | {
        scope: "controller" | "everyNode";
        kind: "observation" | "capability";
        id: string;
        state: "present" | "absent";
      }
    | {
        scope: "controller" | "everyNode";
        kind: "qualification";
        id: string;
        status: "qualified" | "unqualified";
      };
}

export interface ServingPreset {
  apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  kind: "ServingPreset";
  metadata: ServingMetadata;
  spec: {
    selection: ServingSelectionPolicy;
    priority: number;
    requirements?: { all: ServingReadinessRequirement[] };
    plan: {
      backend: string;
      recipeRef: string;
    };
  };
}

export interface ServingCatalogSourceProvenance {
  path: string;
  kind: ServingDefinitionKind;
  id: string;
  digest: string;
}

export interface CompiledServingCatalogPayload {
  schemaVersion: "1.0.0";
  compilerVersion: "1.0.0";
  sourceRevision: string;
  readinessSchemaRef: "https://github.com/NVIDIA/NemoClaw/schemas/system-readiness.schema.json";
  recipes: ServingRecipe[];
  presets: ServingPreset[];
  sources: ServingCatalogSourceProvenance[];
}

export interface CompiledServingCatalog extends CompiledServingCatalogPayload {
  catalogDigest: string;
}

export interface ServingCatalogSource {
  path: string;
  contents: string;
}

export interface ServingCatalogSchemas {
  catalog: object;
  preset: object;
  recipe: object;
}

export interface ServingCatalogRegistries {
  materializers: ReadonlySet<string>;
  lifecycles: ReadonlySet<string>;
  readiness: ReadonlyMap<string, ReadinessEntityKind>;
}
