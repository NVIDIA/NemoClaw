// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SystemReadinessReport } from "../../readiness/types.js";

export type ServingDefinitionKind =
  "ServingModel" | "ServingRecipe" | "ServingPreset";
export type ServingSelectionPolicy = "automatic" | "explicit-only" | "disabled";
export type ServingSupportState = "supported" | "experimental" | "disabled";

/** Secret-free, immutable catalog identity persisted across onboarding lifecycle operations. */
export interface ServingProfileProvenance {
  readonly schemaVersion: 1;
  readonly catalogDigest: string;
  readonly preset: {
    readonly id: string;
    readonly digest: string;
    readonly displayName: string;
    readonly supportState: ServingSupportState;
  };
  readonly recipe: {
    readonly id: string;
    readonly digest: string;
    readonly backend: string;
  };
  readonly model: {
    readonly id: string;
    readonly revision: string;
  };
  readonly runtimeImage: string | null;
  readonly estimatedImageDownloadBytes: number | null;
  readonly estimatedModelDownloadBytes: number | null;
}
export type ReadinessEntityKind =
  "observation" | "capability" | "qualification";
export type ReadinessValueType = "boolean" | "number" | "string" | "version";
export type ServingReadinessObservationRole =
  | "operating-system"
  | "architecture"
  | "container-runtime"
  | "gpu-count"
  | "driver-version";

export interface ServingMetadata {
  readonly id: string;
  readonly displayName?: string;
  readonly supportState?: ServingSupportState;
  readonly validation?: {
    readonly level: "schema" | "software" | "hardware";
    readonly evidence: string;
  };
}

export interface ServingModelCapabilities {
  readonly chatCompletions: boolean;
  readonly streaming: boolean;
  readonly toolCalls: boolean;
  readonly structuredOutputs: boolean;
  readonly reasoning: boolean;
  readonly multimodal: boolean;
}

export interface ServingModelDefinition {
  readonly apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  readonly kind: "ServingModel";
  readonly metadata: Pick<ServingMetadata, "id" | "displayName">;
  readonly spec: ManagedInferenceServingRecipe["spec"]["model"] & {
    readonly capabilities: ServingModelCapabilities;
    readonly probePolicyRef: string;
  };
}

export interface ServingArgument {
  readonly name: string;
  readonly value?: string | number | boolean;
}

export interface ServingTopologyBinding {
  readonly type: "topologyQualificationOutput";
  readonly qualificationId: string;
  readonly schemaVersion: number;
  readonly outputSchema: string;
}

export type ServingModelPreparation =
  | { readonly ref: "none/v1" }
  | {
      readonly ref: "snapshot-copy-and-exact-text-replacement/v1";
      readonly snapshotCopy: {
        readonly sourcePath: string;
        readonly digest: string;
        readonly targetPath: string;
      };
      readonly exactTextReplacement: {
        readonly targetPath: string;
        readonly expectedText: string;
        readonly replacementText: string;
      };
    };

export interface ServingTemporaryFilesystem {
  readonly target: string;
  readonly sizeBytes: number;
  readonly mode: string;
  readonly options: readonly string[];
}

export interface VllmDirectInstallPolicy {
  /** Authentication used by the legacy NEMOCLAW_VLLM_MODEL install surface. */
  readonly authentication: "none" | "bearer";
  /** Whether VLLM_EXTRA_ARGS is rejected for the direct install surface. */
  readonly fixedArguments: boolean;
  /** Whether the direct install surface owns a catalog lifecycle receipt. */
  readonly catalogReceipt: boolean;
}

export interface ServingStationPairOrchestration {
  readonly image: string;
  readonly imageDownloadSizeBytes: number;
  readonly servedName: string;
  readonly nodeCount: 2;
  readonly tensorParallelSize: number;
  readonly pipelineParallelSize: number;
  readonly loadTimeoutSeconds: number;
}

export interface ManagedInferenceServingRecipe {
  readonly apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  readonly kind: "ServingRecipe";
  readonly metadata: ServingMetadata;
  readonly spec: {
    readonly backend: string;
    readonly bindings: Readonly<Record<string, ServingTopologyBinding>>;
    readonly model: {
      readonly id: string;
      readonly revision: string;
      readonly environmentValue: string;
      readonly displayName: string;
      readonly menuOrder: number;
      readonly servedName: string;
      readonly files?: readonly {
        readonly path: string;
        readonly digest: string;
      }[];
      readonly downloadSizeBytes: number;
      readonly gated: boolean;
      readonly installFastSafetensors: boolean;
      readonly preparation: ServingModelPreparation;
      readonly capabilities?: ServingModelCapabilities;
      readonly probePolicyRef?: string;
    };
    readonly modelRef?: string;
    readonly runtime: {
      readonly image: string;
      readonly imageDownloadSizeBytes: number;
      readonly imageUnpackedSizeBytes?: number;
      readonly minimumComputeCapability: number;
      readonly minimumGpuMemoryBytes?: number;
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
      readonly temporaryFilesystems: readonly ServingTemporaryFilesystem[];
      readonly environment: Readonly<Record<string, string>>;
      readonly components?: Readonly<Record<string, string>>;
    };
    readonly execution: {
      readonly materializerRef: string;
      readonly lifecycleRef: string;
      readonly orchestrationRef?: string;
      readonly stationPair?: ServingStationPairOrchestration;
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
      readonly arguments: readonly ServingArgument[];
      readonly directInstall?: VllmDirectInstallPolicy;
    };
    readonly readiness: {
      readonly timeoutSeconds: number;
      readonly expectedModel: string;
    };
  };
}

/** A single-host vLLM recipe, with cluster-only inputs unavailable by construction. */
export interface HostLocalInferenceServingRecipe extends Omit<
  ManagedInferenceServingRecipe,
  "spec"
> {
  readonly spec: Omit<
    ManagedInferenceServingRecipe["spec"],
    "backend" | "bindings" | "execution"
  > & {
    readonly backend: "vllm";
    readonly bindings?: never;
    readonly execution: {
      readonly materializerRef: "vllm.host-local/v1";
      readonly lifecycleRef: "vllm.host-local.lifecycle/v1";
      readonly orchestrationRef?: string;
      readonly stationPair?: ServingStationPairOrchestration;
      readonly topologyBinding?: never;
      readonly nodeCount?: never;
      readonly tensorParallelSize?: never;
      readonly pipelineParallelSize?: never;
      readonly distributedExecutorBackend?: never;
      readonly rendezvousPort?: never;
    };
  };
}

export type ManagedInferenceRuntimeServingRecipe =
  | ManagedInferenceServingRecipe
  | HostLocalInferenceServingRecipe
  | LlamaCppServingRecipe;

interface ServingRecipeEnvelope {
  readonly apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  readonly kind: "ServingRecipe";
  readonly metadata: ServingMetadata;
}

interface GenericServingRecipe extends ServingRecipeEnvelope {
  readonly spec: {
    readonly backend: string;
    readonly providerId?: never;
    readonly server?: never;
    readonly bindings?: Readonly<Record<string, ServingTopologyBinding>>;
    readonly model: {
      readonly id: string;
      readonly revision: string;
      readonly environmentValue?: string;
      readonly displayName?: string;
      readonly menuOrder?: number;
      readonly servedName?: string;
      readonly files?: readonly {
        readonly path: string;
        readonly digest: string;
      }[];
      readonly downloadSizeBytes?: number;
      readonly gated?: boolean;
      readonly installFastSafetensors?: boolean;
      readonly preparation?: ServingModelPreparation;
      readonly capabilities?: ServingModelCapabilities;
      readonly probePolicyRef?: string;
    };
    readonly modelRef?: string;
    readonly runtime?: Partial<
      ManagedInferenceServingRecipe["spec"]["runtime"]
    > & {
      readonly components?: Readonly<Record<string, string>>;
      readonly minimumComputeCapability?: number;
    };
    readonly execution: {
      readonly receiptRef?: string;
      readonly materializerRef: string;
      readonly lifecycleRef: string;
      readonly orchestrationRef?: string;
      readonly stationPair?: ServingStationPairOrchestration;
      readonly topologyBinding?: string;
      readonly nodeCount?: number;
      readonly tensorParallelSize?: number;
      readonly pipelineParallelSize?: number;
      readonly distributedExecutorBackend?: string;
      readonly rendezvousPort?: number;
    };
    readonly serve?: {
      readonly authentication?: string;
      readonly executable?: string;
      readonly arguments?: readonly ServingArgument[];
      readonly directInstall?: Partial<VllmDirectInstallPolicy>;
    };
    readonly readiness?: {
      readonly contractRef?: string;
      readonly timeoutSeconds?: number;
      readonly expectedModel?: string;
    };
  };
}

export interface LlamaCppServingRecipe extends ServingRecipeEnvelope {
  readonly spec: {
    readonly backend: "install-llama-cpp";
    readonly providerId: "llama-cpp-local";
    readonly bindings?: never;
    readonly server: {
      readonly technology: "llama.cpp";
      readonly source: {
        readonly repository: string;
        readonly revision: string;
      };
    };
    readonly model: {
      readonly id: string;
      readonly revision: string;
      readonly servedName: string;
      readonly files: readonly {
        readonly path: string;
        readonly digest: string;
        readonly sizeBytes: number;
        readonly format: "gguf";
        readonly quantization: string;
        readonly license: string;
      }[];
      readonly acquisition: {
        readonly ref: "hugging-face-exact-file/v1";
        readonly downloaderImage: string;
        readonly authentication: {
          readonly mode: "optional";
          readonly environment: "HF_TOKEN";
        };
      };
      readonly cache: {
        readonly ref: "hugging-face-shared-cache/v1";
        readonly root: "user-cache";
        readonly reuse: "verify-exact-file";
        readonly sharing: "host-user";
        readonly cleanup: "preserve";
      };
      readonly probePolicyRef?: never;
    };
    readonly modelRef?: never;
    readonly runtime: {
      readonly image: string;
      readonly imageDownloadSizeBytes: number;
      readonly platforms: readonly ("linux/amd64" | "linux/arm64")[];
      readonly containerRuntime: "docker";
      readonly networkExposure: "loopback";
      readonly restartPolicy: "unless-stopped";
      readonly hosts: 1;
      readonly cuda: {
        readonly baseImage: string;
        readonly minimumDriverVersion: string;
      };
      readonly gpu: {
        readonly vendor: "nvidia";
        readonly count: 1;
        readonly offload: "full";
        readonly cpuFallback: "reject";
      };
      readonly resources: {
        readonly memoryBytes: number;
        readonly writableStorageBytes: number;
        readonly pidsLimit: number;
      };
    };
    readonly execution: {
      readonly receiptRef: string;
      readonly materializerRef: string;
      readonly lifecycleRef: string;
      readonly orchestrationRef?: never;
      readonly stationPair?: never;
      readonly nodeCount?: never;
    };
    readonly serve: {
      readonly protocol: "openai-completions";
      readonly authentication: "bearer";
      readonly port: 8081;
      readonly chatTemplate:
        | "nemotron-v3-embedded"
        | "container-jinja-file"
        | "model-embedded-jinja";
      readonly chatTemplateFile?: string;
      readonly chatTemplateArguments?: {
        readonly reasoningStrength: "low" | "medium" | "high" | "xhigh";
      };
      readonly reasoning?: {
        readonly format: "deepseek";
        readonly mode: "auto";
      };
      readonly contextSize: number;
      readonly slots: 1;
      readonly idleSleepSeconds: -1;
      readonly batchSize: number;
      readonly microBatchSize: number;
      readonly flashAttention: "enabled";
      readonly kvCache: {
        readonly key: "f16" | "q8_0";
        readonly value: "f16" | "q8_0";
      };
      readonly speculativeDecoding: "disabled";
      readonly limits: {
        readonly maxRequestBodyBytes: number;
        readonly maxRequestHeaderBytes: number;
        readonly maxOutputTokens: number;
        readonly requestTimeoutSeconds: number;
        readonly shutdownTimeoutSeconds: number;
      };
      readonly requestGuard: {
        readonly upstreamPort: number;
      };
    };
    readonly readiness: {
      readonly contractRef: string;
      readonly timeoutSeconds: number;
      readonly expectedModel: string;
      readonly probeImage: string;
      readonly probes: {
        readonly models: true;
        readonly health: true;
        readonly properties: true;
        readonly metrics: true;
      };
    };
    readonly policy: {
      readonly egress: "disabled";
      readonly modelSource: "verified-local";
      readonly modelDownloads: "disabled";
    };
    readonly surfaces: {
      readonly ui: "disabled";
      readonly slotInspection: "disabled";
      readonly router: "disabled";
      readonly mcpProxy: "disabled";
      readonly serverTools: "disabled";
      readonly agentMode: "disabled";
      readonly multimodalProjection: "disabled";
    };
    readonly capabilities: {
      readonly agents: readonly {
        readonly id: string;
        readonly qualificationRef: string;
      }[];
      readonly protocols: readonly ["openai-completions"];
      readonly streaming: boolean;
      readonly toolCalls: boolean;
      readonly structuredOutputs: boolean;
      readonly parallelToolCalls: false;
      readonly responsesApi: false;
      readonly embeddings: false;
      readonly reranking: false;
      readonly multimodal: false;
    };
  };
}

export type ServingRecipe = GenericServingRecipe | LlamaCppServingRecipe;

export type ServingReadinessComparison =
  | { readonly operator: "equals"; readonly value: string | number | boolean }
  | {
      readonly operator: "one-of";
      readonly values: readonly (string | number | boolean)[];
    }
  | { readonly operator: "at-least"; readonly value: number }
  | { readonly operator: "version-at-least"; readonly value: string };

export type ServingReadinessRequirement =
  | {
      readonly readiness: {
        readonly scope: "controller" | "everyNode" | "anyNode";
        readonly kind: "qualification";
        readonly id: string;
        readonly status: string;
      };
    }
  | {
      readonly readiness: {
        readonly scope: "controller" | "everyNode" | "anyNode";
        readonly kind: "observation" | "capability";
        readonly id: string;
        readonly state: string;
      };
    }
  | {
      readonly readiness: {
        readonly scope: "controller" | "everyNode" | "anyNode";
        readonly kind: "observation";
        readonly id: string;
        readonly comparison: ServingReadinessComparison;
      };
    };

export type ServingFactValue =
  string | number | boolean | readonly (string | number | boolean)[];

export interface ServingFactRequirement {
  readonly fact: string;
  readonly state: "present" | "absent";
  readonly operator: "equals" | "oneOf" | "atLeast" | "atMost" | "between";
  readonly value: ServingFactValue;
}

export interface ServingTopologyRequirement {
  readonly topologyQualification: {
    readonly id: string;
    readonly schemaVersion: number;
    readonly status: string;
  };
}

export type ServingPresetRequirement =
  | ServingReadinessRequirement
  | ServingFactRequirement
  | ServingTopologyRequirement;

export interface ServingPresetTopologyBinding {
  readonly valueFromTopologyQualification: {
    readonly id: string;
    readonly schemaVersion: number;
    readonly output: string;
  };
}

export interface ManagedInferenceServingPreset {
  readonly apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  readonly kind: "ServingPreset";
  readonly metadata: ServingMetadata;
  readonly spec: {
    readonly selection: ServingSelectionPolicy;
    readonly priority: number;
    readonly featureGate?: string;
    readonly requirements: {
      readonly all: readonly ServingPresetRequirement[];
    };
    readonly plan: {
      readonly backend: string;
      readonly recipeRef: string;
      readonly installPolicyRef?: string;
      readonly platform?: "spark" | "station" | "n1x" | "linux";
      readonly interactive?: boolean;
      readonly bindings?: Readonly<
        Record<string, ServingPresetTopologyBinding>
      >;
    };
  };
}

export interface ServingPreset {
  readonly apiVersion: "nemoclaw.nvidia.com/managed-inference/v1";
  readonly kind: "ServingPreset";
  readonly metadata: ServingMetadata;
  readonly spec: {
    readonly selection: ServingSelectionPolicy;
    readonly priority: number;
    readonly featureGate?: string;
    readonly requirements?: {
      readonly all: readonly ServingPresetRequirement[];
    };
    readonly plan: {
      readonly backend: string;
      readonly recipeRef: string;
      readonly installPolicyRef?: string;
      readonly platform?: "spark" | "station" | "n1x" | "linux";
      readonly interactive?: boolean;
      readonly bindings?: Readonly<
        Record<string, ServingPresetTopologyBinding>
      >;
    };
  };
}

export interface ServingCatalogSourceProvenance {
  readonly path: string;
  readonly kind: ServingDefinitionKind;
  readonly id: string;
  readonly digest: string;
}

export interface CompiledServingCatalogPayload {
  readonly schemaVersion: "1.1.0";
  readonly compilerVersion: "1.4.0";
  readonly sourceRevision: string;
  readonly readinessSchemaRef: "https://github.com/NVIDIA/NemoClaw/schemas/system-readiness.schema.json";
  readonly models: readonly ServingModelDefinition[];
  readonly recipes: readonly ServingRecipe[];
  readonly presets: readonly ServingPreset[];
  readonly sources: readonly ServingCatalogSourceProvenance[];
}

export interface CompiledServingCatalog extends CompiledServingCatalogPayload {
  readonly catalogDigest: string;
}

export interface ServingCatalogSource {
  readonly path: string;
  readonly contents: string;
}

export interface ServingCatalogSchemas {
  readonly catalog: object;
  readonly model: object;
  readonly preset: object;
  readonly recipe: object;
}

export interface ServingTopologyRegistryEntry {
  readonly bindingOutput: string;
  readonly outputSchema: string;
}

export interface ServingReadinessRegistryEntry {
  readonly kind: ReadinessEntityKind;
  readonly valueType?: ReadinessValueType;
  readonly role?: ServingReadinessObservationRole;
}

export type ServingReadinessRegistryValue =
  | ReadinessEntityKind
  | ReadonlySet<ReadinessEntityKind>
  | ServingReadinessRegistryEntry;

export interface ServingCatalogRegistries {
  readonly receipts: ReadonlySet<string>;
  readonly materializers: ReadonlySet<string>;
  readonly lifecycles: ReadonlySet<string>;
  readonly readinessContracts: ReadonlySet<string>;
  readonly installPolicies?: ReadonlySet<string>;
  readonly probePolicies?: ReadonlySet<string>;
  readonly orchestrations?: ReadonlySet<string>;
  readonly readiness: ReadonlyMap<string, ServingReadinessRegistryValue>;
  readonly facts?: ReadonlySet<string>;
  readonly topologyQualifications?: ReadonlyMap<
    string,
    ServingTopologyRegistryEntry
  >;
  readonly validateRecipe?: (recipe: ServingRecipe) => string | undefined;
}

export type ManagedInferenceServingArgument = ServingArgument;
export type ManagedInferenceTopologyBinding = ServingTopologyBinding;
export type ManagedInferenceModelPreparation = ServingModelPreparation;
export type ManagedInferenceTemporaryFilesystem = ServingTemporaryFilesystem;
export type ManagedInferenceReadinessRequirement = ServingReadinessRequirement;
export type ManagedInferenceFactValue = ServingFactValue;
export type ManagedInferenceFactRequirement = ServingFactRequirement;
export type ManagedInferenceTopologyRequirement = ServingTopologyRequirement;
export type ManagedInferencePresetRequirement = ServingPresetRequirement;
export type ManagedInferencePresetTopologyBinding =
  ServingPresetTopologyBinding;
export interface CompiledManagedInferenceCatalog extends Omit<
  CompiledServingCatalog,
  "presets" | "recipes"
> {
  readonly presets: readonly ManagedInferenceServingPreset[];
  readonly recipes: readonly ManagedInferenceRuntimeServingRecipe[];
}

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

export function isManagedInferenceMaterializerOwnedArgument(
  name: string,
): boolean {
  return MATERIALIZER_OWNED_SERVE_ARGUMENTS.has(name);
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

export interface ResolvedHostLocalInferenceSelection {
  readonly outcome: "selected";
  readonly selection: "automatic" | "explicit";
  readonly catalogDigest: string;
  readonly presetDigest: string;
  readonly recipeDigest: string;
  readonly preset: ManagedInferenceServingPreset;
  readonly recipe: HostLocalInferenceServingRecipe;
}

export interface ResolvedLlamaCppInferenceSelection {
  readonly outcome: "selected";
  readonly selection: "automatic" | "explicit";
  readonly catalogDigest: string;
  readonly presetDigest: string;
  readonly recipeDigest: string;
  readonly preset: ManagedInferenceServingPreset;
  readonly recipe: LlamaCppServingRecipe;
}

export type ManagedInferenceResolution<TTopologyOutput = unknown> =
  | ResolvedManagedInferenceSelection<TTopologyOutput>
  | ResolvedHostLocalInferenceSelection
  | ResolvedLlamaCppInferenceSelection
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
