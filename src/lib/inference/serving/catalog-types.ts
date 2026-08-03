// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SystemReadinessReport } from "../../readiness/types.js";

export const MANAGED_INFERENCE_CATALOG_SCHEMA_VERSION = "1.0.0" as const;
export const MANAGED_INFERENCE_CATALOG_COMPILER_VERSION = "1.0.0" as const;
export const DUAL_SPARK_PRESET_ID = "vllm.dgx-spark-gb10.dual.deepseek-v4-flash-0731" as const;
export const DUAL_SPARK_RECIPE_ID = "vllm.deepseek-v4-flash-0731.spark-dual.v1" as const;
export const DUAL_SPARK_RECIPE_SPEC_DIGEST =
  "sha256:32d4233427cc9fe99a143a52887b66232aeaf650712ad1b8b6ff673743fe9637" as const;
export const DUAL_SPARK_TOPOLOGY_QUALIFICATION_ID = "dgx-spark.gb10.dual-cx7" as const;
export const DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION = 1 as const;

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

export interface ManagedInferenceServingRecipe {
  readonly apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  readonly kind: "ServingRecipe";
  readonly metadata: ManagedInferenceMetadata;
  readonly spec: {
    readonly backend: "vllm";
    readonly bindings: {
      readonly sparkTopology: {
        readonly type: "topologyQualificationOutput";
        readonly qualificationId: typeof DUAL_SPARK_TOPOLOGY_QUALIFICATION_ID;
        readonly schemaVersion: typeof DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION;
        readonly outputSchema: "nemoclaw.nvidia.com/dual-spark-topology/v1";
      };
    };
    readonly model: {
      readonly id: string;
      readonly revision: string;
      readonly servedName: string;
      readonly downloadSizeBytes: number;
      readonly preparationRef: "deepseek-v4-flash-0731/v1";
      readonly encodingPath: "encoding/encoding_dsv4.py";
    };
    readonly runtime: {
      readonly image: string;
      readonly imageDownloadSizeBytes: number;
      readonly architecture: "arm64";
      readonly networkMode: "host";
      readonly ipcMode: "host";
      readonly sharedMemoryBytes: number;
      readonly devices: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
    };
    readonly execution: {
      readonly materializerRef: "vllm.dual-dgx-spark/v1";
      readonly lifecycleRef: "vllm.dual-dgx-spark/v1";
      readonly topologyBinding: "sparkTopology";
      readonly nodeCount: 2;
      readonly tensorParallelSize: 2;
      readonly pipelineParallelSize: 1;
      readonly distributedExecutorBackend: "mp";
    };
    readonly serve: {
      readonly authentication: "bearer";
      readonly arguments: readonly ManagedInferenceServingArgument[];
    };
    readonly readiness: {
      readonly timeoutSeconds: number;
      readonly expectedModel: string;
    };
  };
}

export type ManagedInferencePresetRequirement =
  | {
      readonly readiness: {
        readonly scope: "everyNode";
        readonly kind: "qualification";
        readonly id: "host.platform.dgx_spark";
        readonly status: "qualified";
      };
    }
  | {
      readonly fact: "cluster.nodeCount";
      readonly state: "present";
      readonly operator: "equals";
      readonly value: number;
    }
  | {
      readonly topologyQualification: {
        readonly id: typeof DUAL_SPARK_TOPOLOGY_QUALIFICATION_ID;
        readonly schemaVersion: typeof DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION;
        readonly status: "qualified";
      };
    };

export interface ManagedInferenceServingPreset {
  readonly apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  readonly kind: "ServingPreset";
  readonly metadata: ManagedInferenceMetadata;
  readonly spec: {
    readonly selection: "automatic";
    readonly requirements: {
      readonly all: readonly ManagedInferencePresetRequirement[];
    };
    readonly plan: {
      readonly backend: "vllm";
      readonly recipeRef: string;
      readonly bindings: {
        readonly sparkTopology: {
          readonly valueFromTopologyQualification: {
            readonly id: typeof DUAL_SPARK_TOPOLOGY_QUALIFICATION_ID;
            readonly schemaVersion: typeof DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION;
            readonly output: "topology";
          };
        };
      };
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
        | "requirements-not-met";
      readonly message: string;
    };
