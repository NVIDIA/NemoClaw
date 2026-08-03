// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SystemReadinessReport } from "../../readiness/types.js";

export const MANAGED_INFERENCE_CATALOG_SCHEMA_VERSION = "1.0.0" as const;
export const MANAGED_INFERENCE_CATALOG_COMPILER_VERSION = "1.0.0" as const;

const MATERIALIZER_OWNED_SERVE_ARGUMENTS = new Set([
  "--api-key",
  "--distributed-executor-backend",
  "--headless",
  "--host",
  "--master-addr",
  "--master-port",
  "--nnodes",
  "--node-rank",
  "--pipeline-parallel-size",
  "--revision",
  "--served-model-name",
  "--tensor-parallel-size",
]);

export function isManagedInferenceMaterializerOwnedArgument(name: string): boolean {
  return MATERIALIZER_OWNED_SERVE_ARGUMENTS.has(name);
}

export interface ManagedInferenceMetadata {
  readonly id: string;
  readonly displayName: string;
}

export interface ManagedInferenceServingArgument {
  readonly name: string;
  readonly value?: string | number | boolean;
}

export interface ManagedInferenceTopologyBinding {
  readonly type: "topologyQualificationOutput";
  readonly qualificationId: string;
  readonly schemaVersion: number;
  readonly outputSchema: string;
}

export type ManagedInferenceModelPreparation =
  | { readonly ref: "none/v1" }
  | {
      readonly ref: "snapshot-copy-and-exact-text-replacement/v1";
      readonly snapshotCopy: {
        readonly sourcePath: string;
        readonly targetPath: string;
      };
      readonly exactTextReplacement: {
        readonly targetPath: string;
        readonly expectedText: string;
        readonly replacementText: string;
      };
    };

export interface ManagedInferenceTemporaryFilesystem {
  readonly target: string;
  readonly sizeBytes: number;
  readonly mode: string;
  readonly options: readonly string[];
}

export interface ManagedInferenceServingRecipe {
  readonly apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  readonly kind: "ServingRecipe";
  readonly metadata: ManagedInferenceMetadata;
  readonly spec: {
    readonly backend: string;
    readonly bindings: Readonly<Record<string, ManagedInferenceTopologyBinding>>;
    readonly model: {
      readonly id: string;
      readonly revision: string;
      readonly servedName: string;
      readonly downloadSizeBytes: number;
      readonly gated: boolean;
      readonly installFastSafetensors: boolean;
      readonly preparation: ManagedInferenceModelPreparation;
    };
    readonly runtime: {
      readonly image: string;
      readonly imageDownloadSizeBytes: number;
      readonly pullTimeoutSeconds: number;
      readonly architecture: string;
      readonly networkMode: string;
      readonly ipcMode: string;
      readonly sharedMemoryBytes: number;
      readonly gpuRequest: string;
      readonly devices: readonly string[];
      readonly ulimits: {
        readonly memlock: number | string;
        readonly stackBytes: number;
      };
      readonly modelCache: {
        readonly source: string;
        readonly target: string;
      };
      readonly temporaryFilesystems: readonly ManagedInferenceTemporaryFilesystem[];
      readonly environment: Readonly<Record<string, string>>;
    };
    readonly execution: {
      readonly materializerRef: string;
      readonly lifecycleRef: string;
      readonly topologyBinding: string;
      readonly nodeCount: number;
      readonly tensorParallelSize: number;
      readonly pipelineParallelSize: number;
      readonly distributedExecutorBackend: string;
      readonly rendezvousPort: number;
    };
    readonly serve: {
      readonly authentication: string;
      readonly executable: string;
      readonly arguments: readonly ManagedInferenceServingArgument[];
    };
    readonly readiness: {
      readonly timeoutSeconds: number;
      readonly expectedModel: string;
    };
  };
}

export type ManagedInferenceReadinessRequirement =
  | {
      readonly readiness: {
        readonly scope: "everyNode" | "anyNode";
        readonly kind: "qualification";
        readonly id: string;
        readonly status: string;
      };
    }
  | {
      readonly readiness: {
        readonly scope: "everyNode" | "anyNode";
        readonly kind: "observation" | "capability";
        readonly id: string;
        readonly state: string;
      };
    };

export type ManagedInferenceFactValue =
  | string
  | number
  | boolean
  | readonly (string | number | boolean)[];

export interface ManagedInferenceFactRequirement {
  readonly fact: string;
  readonly state: "present" | "absent";
  readonly operator: "equals" | "oneOf" | "atLeast" | "atMost" | "between";
  readonly value: ManagedInferenceFactValue;
}

export interface ManagedInferenceTopologyRequirement {
  readonly topologyQualification: {
    readonly id: string;
    readonly schemaVersion: number;
    readonly status: string;
  };
}

export type ManagedInferencePresetRequirement =
  | ManagedInferenceReadinessRequirement
  | ManagedInferenceFactRequirement
  | ManagedInferenceTopologyRequirement;

export interface ManagedInferencePresetTopologyBinding {
  readonly valueFromTopologyQualification: {
    readonly id: string;
    readonly schemaVersion: number;
    readonly output: string;
  };
}

export interface ManagedInferenceServingPreset {
  readonly apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  readonly kind: "ServingPreset";
  readonly metadata: ManagedInferenceMetadata;
  readonly spec: {
    readonly selection: "automatic" | "explicit-only" | "disabled";
    readonly priority: number;
    readonly requirements: {
      readonly all: readonly ManagedInferencePresetRequirement[];
    };
    readonly plan: {
      readonly backend: string;
      readonly recipeRef: string;
      readonly bindings: Readonly<Record<string, ManagedInferencePresetTopologyBinding>>;
    };
  };
}

export interface CompiledManagedInferenceDefinition<TDefinition> {
  readonly definition: TDefinition;
  readonly definitionDigest: string;
  readonly sourceFile: string;
}

export interface CompiledManagedInferenceCatalog {
  readonly catalogDigest: string;
  readonly compilerVersion: typeof MANAGED_INFERENCE_CATALOG_COMPILER_VERSION;
  readonly presets: readonly CompiledManagedInferenceDefinition<ManagedInferenceServingPreset>[];
  readonly recipes: readonly CompiledManagedInferenceDefinition<ManagedInferenceServingRecipe>[];
  readonly schemaVersion: typeof MANAGED_INFERENCE_CATALOG_SCHEMA_VERSION;
  readonly sourceFiles: readonly {
    readonly digest: string;
    readonly path: string;
  }[];
  readonly sourceRevision: string;
}

export interface ManagedInferenceTopologyQualification<TOutput = unknown> {
  readonly id: string;
  readonly schemaVersion: number;
  readonly status: "qualified" | "unqualified" | "unknown";
  readonly subjectNodeIds: readonly string[];
  readonly subjectDigest: string;
  readonly outputDigest: string;
  readonly output: TOutput;
}

export interface ManagedInferenceReadinessSource {
  readonly nodeId: string;
  readonly report: SystemReadinessReport;
}

export interface ManagedInferenceSelectionIntent {
  readonly provider?: string;
  readonly vllmModel?: string;
  readonly vllmExtraArguments?: readonly string[];
  readonly preset?: string;
}

export interface ManagedInferenceResolverInput<TTopologyOutput = unknown> {
  readonly readinessReports: readonly ManagedInferenceReadinessSource[];
  readonly topologyQualifications: readonly ManagedInferenceTopologyQualification<TTopologyOutput>[];
  readonly intent?: ManagedInferenceSelectionIntent;
  readonly now?: Date;
  readonly maxReadinessAgeMs?: number;
}

export interface ResolvedManagedInferenceSelection<TTopologyOutput = unknown> {
  readonly outcome: "selected";
  readonly selection: "automatic" | "explicit";
  readonly catalogDigest: string;
  readonly presetDigest: string;
  readonly recipeDigest: string;
  readonly preset: ManagedInferenceServingPreset;
  readonly recipe: ManagedInferenceServingRecipe;
  readonly topologyQualification: ManagedInferenceTopologyQualification<TTopologyOutput>;
}

export type ManagedInferenceResolution<TTopologyOutput = unknown> =
  | ResolvedManagedInferenceSelection<TTopologyOutput>
  | {
      readonly outcome: "no-match";
      readonly code: "explicit-intent" | "requirements-not-met";
      readonly message: string;
    }
  | {
      readonly outcome: "rejected";
      readonly code:
        | "unknown-preset"
        | "incompatible-intent"
        | "invalid-readiness"
        | "invalid-topology"
        | "ambiguous-selection"
        | "requirements-not-met";
      readonly message: string;
    };
