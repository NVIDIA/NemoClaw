// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ServingDefinitionKind = "ServingRecipe" | "ServingPreset";
export type ServingSelectionPolicy = "automatic" | "explicit-only" | "disabled";
export type ReadinessEntityKind = "observation" | "capability" | "qualification";
export type ReadinessValueType = "boolean" | "number" | "string" | "version";
export type ServingReadinessObservationRole =
  | "operating-system"
  | "architecture"
  | "container-runtime"
  | "gpu-count"
  | "driver-version";

export interface ServingMetadata {
  id: string;
  displayName?: string;
}

interface ServingRecipeEnvelope {
  apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  kind: "ServingRecipe";
  metadata: ServingMetadata;
}

interface GenericServingRecipe extends ServingRecipeEnvelope {
  spec: {
    backend: string;
    providerId?: never;
    server?: never;
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
      receiptRef?: string;
      materializerRef: string;
      lifecycleRef: string;
    };
    serve?: {
      arguments?: Array<{ name: string; value?: string | number | boolean }>;
    };
    readiness?: {
      contractRef?: string;
      timeoutSeconds?: number;
      expectedModel?: string;
    };
  };
}

interface LlamaCppServingRecipe extends ServingRecipeEnvelope {
  spec: {
    backend: "install-llama-cpp";
    providerId: "llama-cpp-local";
    server: {
      technology: "llama.cpp";
      source: { repository: string; revision: string };
    };
    model: {
      id: string;
      revision: string;
      servedName: string;
      files: Array<{
        path: string;
        digest: string;
        sizeBytes: number;
        format: "gguf";
        quantization: string;
        license: string;
      }>;
    };
    runtime: {
      image: string;
      platforms: Array<"linux/amd64" | "linux/arm64">;
      containerRuntime: "docker";
      hosts: 1;
      cuda: { baseImage: string; minimumDriverVersion: string };
      gpu: { vendor: "nvidia"; count: 1; offload: "full"; cpuFallback: "reject" };
      resources: { memoryBytes: number; writableStorageBytes: number; pidsLimit: number };
    };
    execution: {
      receiptRef: string;
      materializerRef: string;
      lifecycleRef: string;
    };
    serve: {
      protocol: "openai-completions";
      port: 8081;
      chatTemplate: string;
      contextSize: number;
      slots: 1;
      idleSleepSeconds: -1;
      limits: {
        maxRequestBodyBytes: number;
        maxPromptTokens: number;
        maxCompletionTokens: number;
        requestTimeoutSeconds: number;
      };
    };
    readiness: {
      contractRef: string;
      timeoutSeconds: number;
      expectedModel: string;
      probes: { models: true; health: true; properties: true; metrics: true };
    };
    policy: {
      egress: "disabled";
      modelSource: "verified-local";
      modelDownloads: "disabled";
    };
    surfaces: {
      ui: "disabled";
      slotInspection: "disabled";
      router: "disabled";
      mcpProxy: "disabled";
      serverTools: "disabled";
      agentMode: "disabled";
      multimodalProjection: "disabled";
    };
    capabilities: {
      agents: Array<{ id: string; qualificationRef: string }>;
      protocols: ["openai-completions"];
      streaming: boolean;
      toolCalls: boolean;
      structuredOutputs: boolean;
      parallelToolCalls: false;
      responsesApi: false;
      embeddings: false;
      reranking: false;
      multimodal: false;
    };
  };
}

export type ServingRecipe = GenericServingRecipe | LlamaCppServingRecipe;

export type ServingReadinessComparison =
  | { operator: "equals"; value: string | number | boolean }
  | { operator: "one-of"; values: Array<string | number | boolean> }
  | { operator: "at-least"; value: number }
  | { operator: "version-at-least"; value: string };

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
        kind: "observation";
        id: string;
        comparison: ServingReadinessComparison;
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
  compilerVersion: "1.1.0";
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
  receipts: ReadonlySet<string>;
  materializers: ReadonlySet<string>;
  lifecycles: ReadonlySet<string>;
  readinessContracts: ReadonlySet<string>;
  readiness: ReadonlyMap<
    string,
    | {
        kind: "observation";
        valueType?: ReadinessValueType;
        role?: ServingReadinessObservationRole;
      }
    | { kind: "capability" | "qualification" }
  >;
}
