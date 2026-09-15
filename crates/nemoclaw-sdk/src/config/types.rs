// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Desired configuration for one deployment. Fields describe authored input before SDK normalization.
pub struct Document {
    #[serde(rename = "apiVersion")]
    /// Configuration API version understood by this SDK.
    pub api_version: String,
    #[serde(rename = "kind")]
    /// Configuration document kind.
    pub kind: String,
    #[serde(rename = "metadata")]
    /// Deployment name and durable ownership identity.
    pub metadata: Metadata,
    #[serde(rename = "spec")]
    /// Gateway, inference provider, and sandbox configuration.
    pub spec: Spec,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Deployment identity persists across apply, export, recovery, and destroy.
pub struct Metadata {
    #[serde(rename = "name")]
    /// Lowercase deployment name.
    pub name: String,
    #[serde(rename = "uid")]
    /// Immutable deployment UUID. Use a fresh UUID for a new deployment and retain it for later operations.
    pub uid: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// The configuration requires one inference provider and one sandbox.
pub struct Spec {
    #[serde(rename = "gateway")]
    /// OpenShell gateway connection or managed gateway settings.
    pub gateway: Gateway,
    #[serde(rename = "inferenceProviders")]
    /// Exactly one external endpoint, managed Ollama server, or managed vLLM service.
    pub inference_providers: Vec<InferenceProvider>,
    #[serde(rename = "sandboxes")]
    /// Exactly one sandbox with one or more OpenClaw agents sharing a primary inference route, or one agent of another harness.
    pub sandboxes: Vec<Sandbox>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// A reference to a caller-provided environment variable; the configuration contains no credential value.
pub struct Credential {
    #[serde(rename = "env")]
    /// Uppercase environment variable name. For TLS fields, its value is a local certificate or key file path; otherwise it is a bearer/API credential.
    pub env: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Gateway mutual TLS file references. All three references are required when TLS is declared.
pub struct TLS {
    #[serde(rename = "ca")]
    /// Environment variable whose value names the local CA certificate file.
    pub ca: Credential,
    #[serde(rename = "certificate")]
    /// Environment variable whose value names the local client certificate file.
    pub certificate: Credential,
    #[serde(rename = "key")]
    /// Environment variable whose value names the local client private-key file.
    pub key: Credential,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Choose a managed local Docker gateway or connect to an external gateway. Credentials and TLS require HTTPS.
pub struct Gateway {
    /// Optional ownership declaration for the gateway network configured by networkCIDR. Omission means managed for a managed gateway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ManagedResource")]
    pub network: Option<super::ManagedResource>,
    /// Optional ownership declaration for gateway storage. Omission means managed for a managed gateway; external gateways cannot declare storage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ManagedResource")]
    pub storage: Option<super::ManagedResource>,
    #[serde(rename = "management")]
    /// Whether the SDK manages the gateway or connects to an existing one.
    pub management: String,
    #[serde(rename = "endpoint")]
    #[schemars(default)]
    /// Gateway HTTP(S) origin, without a path. Required for an external gateway; managed gateways use unprivileged loopback HTTP ports.
    #[schemars(extend("x-nemoclaw-required" = "When external"))]
    pub endpoint: String,
    #[serde(rename = "credential", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Credential")]
    /// Optional bearer credential reference for an external HTTPS gateway.
    pub credential: Option<Credential>,
    #[serde(rename = "tls", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "TLS")]
    /// Optional mutual TLS references for an external HTTPS gateway.
    pub tls: Option<TLS>,
    #[serde(rename = "engine", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Managed gateway Docker socket. Omit or leave empty for an external gateway.
    pub engine: String,
    #[serde(rename = "image", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Managed gateway image pinned by the SDK. Omit or leave empty for an external gateway.
    pub image: String,
    #[serde(rename = "networkCIDR", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Canonical private IPv4 /24 for a managed gateway. Omit or leave empty for an external gateway.
    pub network_cidr: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Choose endpoint for external inference, endpoint plus ollama for managed Ollama, or service for managed vLLM.
pub struct InferenceProvider {
    /// Optional server ownership. Omission means managed with service or ollama, external with endpoint alone. The OpenShell provider registration remains deployment-owned in either mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::Management")]
    pub management: Option<super::Management>,
    #[serde(rename = "name")]
    /// Provider name referenced by the primary route.
    pub name: String,
    #[serde(rename = "provider")]
    /// OpenShell provider implementation. Must match the selected API family.
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::InferenceApi")]
    /// Request API. Omission selects anthropic-messages for Claude, openai-responses for Codex, and openai-completions for other non-Pi harnesses. Pi requires omission and selects its API through native model metadata.
    pub api: Option<super::InferenceApi>,
    #[serde(rename = "endpoint", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Inference HTTP(S) URL. Required without service; omit or leave empty with service. HTTP requires a literal private or loopback address.
    #[schemars(extend("x-nemoclaw-required" = "Without service"))]
    pub endpoint: String,
    #[serde(rename = "credential", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Credential")]
    /// Optional API credential reference for an external HTTPS endpoint. Excluded by service and ollama.
    pub credential: Option<Credential>,
    #[serde(rename = "ollama", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ManagedOllama")]
    /// Manage Ollama through a local Unix Docker socket and an existing network. Requires an explicit private or loopback IP:port/v1 HTTP endpoint.
    pub ollama: Option<ManagedOllama>,
    #[serde(rename = "service", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Service")]
    /// Manage vLLM from a pinned runtime image and model. Excludes ollama and credential; endpoint must be omitted or empty.
    pub service: Option<Service>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Managed Ollama uses a pinned image, an existing Docker network, and an explicit model:tag on the route.
pub struct ManagedOllama {
    /// Optional ownership declaration for installing the route model. Omission means managed; this does not change the selected model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ManagedResource")]
    pub model: Option<super::ManagedResource>,
    /// Optional model-volume ownership declaration. Omission means managed; the volume survives destroy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ManagedResource")]
    pub storage: Option<super::ManagedResource>,
    /// Optional ownership declaration for the Ollama daemon container. Omission means managed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ManagedManagement")]
    pub management: Option<super::ManagedManagement>,
    #[serde(rename = "engine")]
    /// Local Unix Docker socket URL.
    pub engine: String,
    #[serde(rename = "image")]
    /// Immutable ollama/ollama image reference.
    pub image: String,
    #[serde(rename = "network")]
    /// Name of the existing Docker network.
    pub network: super::NetworkReference,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// The gateway owns sandbox creation. Only OpenClaw accepts managed gateway or inference dependencies.
pub struct Sandbox {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::Integrations")]
    /// Optional credential-bearing agent integrations.
    pub integrations: Option<super::Integrations>,
    #[serde(rename = "name")]
    /// Lowercase sandbox name.
    pub name: String,
    #[serde(rename = "image")]
    #[schemars(default)]
    /// Sandbox agent image; omission selects the SDK default.
    pub image: Image,
    #[serde(rename = "runtime")]
    #[schemars(default)]
    /// Sandbox driver; omission selects Docker. A managed gateway requires Docker.
    pub runtime: Runtime,
    #[serde(rename = "network")]
    #[schemars(default)]
    /// Sandbox network policy; omission selects isolated inference routing.
    pub network: Network,
    #[serde(rename = "agents")]
    /// One or more named OpenClaw agents sharing identical inference settings. Other harnesses require one agent.
    pub agents: Vec<Agent>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Sandbox image identity.
pub struct Image {
    #[serde(rename = "ref")]
    #[schemars(default)]
    /// Immutable image reference. Omitted or empty selects the SDK-pinned Fabric image.
    pub ref_: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Sandbox runtime selected through OpenShell.
pub struct Runtime {
    #[serde(rename = "provider")]
    #[schemars(default)]
    /// Docker or Podman driver. A managed service with Podman requires explicit service placement.
    pub provider: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Sandbox policy selection and optional agent HTTP proxy.
pub struct Network {
    #[serde(rename = "tier")]
    #[schemars(default)]
    /// Isolated policy preset. Omit when declaring policy.explicit; omission without policy selects isolated.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::ExplicitPolicySelection")]
    /// Complete authored OpenShell policy, replacing the isolated preset.
    pub policy: Option<super::ExplicitPolicySelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::Proxy")]
    /// HTTP proxy address used by the agent process. Does not create a proxy or change gateway networking.
    pub proxy: Option<super::Proxy>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// One Fabric harness and its inference route.
pub struct Agent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentObservability")]
    /// Shared OpenClaw tracing, declared only on the first agent. Adds the required collector egress grant.
    pub observability: Option<super::AgentObservability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentExecution")]
    /// OpenClaw timeout and heartbeat defaults. Declare only on the first agent in a shared sandbox.
    pub execution: Option<super::AgentExecution>,
    #[serde(rename = "name")]
    /// Lowercase agent name.
    pub name: String,
    #[serde(rename = "harness")]
    /// Agent harness. Harnesses other than openclaw require external gateway and inference services.
    pub harness: String,
    #[serde(rename = "inference")]
    /// Primary inference route for this agent.
    pub inference: Inference,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentAuth")]
    /// Hermes API-key authentication through the routed provider. The provider must declare a credential reference.
    pub auth: Option<super::AgentAuth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentInterfaces")]
    /// Native dashboard access, declared only on the first agent in a sandbox.
    pub interfaces: Option<super::AgentInterfaces>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentTools")]
    /// OpenClaw tool restriction or disclosure mode. Omission selects progressive discovery without restricting tools. allow: [read] restricts tools, not OS-level filesystem access.
    pub tools: Option<super::AgentTools>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Agent inference routing.
pub struct Inference {
    #[serde(rename = "routes")]
    /// Exactly one route named primary.
    pub routes: Vec<Route>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Primary inference route supplied through OpenShell.
pub struct Route {
    #[serde(rename = "name")]
    /// The primary route name.
    pub name: String,
    #[serde(rename = "providerRef")]
    /// Must equal the declared inference provider name.
    pub provider_ref: String,
    #[serde(rename = "overrides")]
    /// Model selection, optional OpenClaw tuning, and optional Pi model metadata.
    pub overrides: Overrides,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Model overrides on the primary route.
pub struct Overrides {
    #[serde(rename = "model")]
    /// Model identifier. For a managed service, match its recipe serving.modelName or, without a recipe, model.repository.
    pub model: String,
    #[serde(flatten)]
    /// OpenClaw native model limits and reasoning defaults.
    pub tuning: super::RouteTuning,
    #[serde(rename = "piModel", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "serde_json::Map<String, serde_json::Value>")]
    /// Opaque custom model metadata for the pi harness. Its object may contain nested null values; the piModel value itself must be an object.
    pub pi_model: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Managed vLLM service. Explicit placement and publication must appear together.
pub struct Service {
    /// Optional ownership declaration for model storage. Omission means managed; existing retention behavior is unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ManagedResource")]
    pub storage: Option<super::ManagedResource>,
    /// Optional managed ownership declaration. Omission means managed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ManagedManagement")]
    pub management: Option<super::ManagedManagement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Box<crate::recipes::inline::InlineRecipe>")]
    /// Optional inline preparation and serving contract supplied by the pinned runtime image.
    pub recipe: Option<Box<crate::recipes::inline::InlineRecipe>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ServicePlacement")]
    /// SSH Docker placement. Required with an external gateway or Podman sandbox; requires publication.
    #[schemars(extend("x-nemoclaw-required" = "With external gateway or Podman; paired with publication"))]
    pub placement: Option<ServicePlacement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ServicePublication")]
    /// Private inference address reachable by OpenShell. Required with placement.
    #[schemars(extend("x-nemoclaw-required" = "With placement"))]
    pub publication: Option<ServicePublication>,
    #[serde(rename = "backend")]
    /// Managed inference backend.
    pub backend: String,
    #[serde(rename = "image")]
    /// Immutable runtime image containing vLLM, the supervisor, and any declared recipe tools.
    pub image: String,
    #[serde(rename = "model")]
    /// Public Hugging Face repository and immutable commit.
    pub model: Model,
    #[serde(rename = "serving")]
    #[schemars(default)]
    /// Service limits. Omission selects the SDK defaults; recipe serving settings select recipe-specific parsers and execution options.
    pub serving: Serving,
    #[serde(rename = "memory")]
    #[schemars(default)]
    /// GPU budget and resident watchdog thresholds. Omission selects the SDK defaults.
    pub memory: Memory,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Immutable model identity used for snapshot resolution and storage.
pub struct Model {
    /// Optional ownership declaration for downloading and preparing this model installation. Omission means managed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ManagedManagement")]
    pub management: Option<super::ManagedManagement>,
    #[serde(rename = "repository")]
    /// Public Hugging Face owner/repository name.
    pub repository: String,
    #[serde(rename = "revision")]
    /// Full lowercase 40-hex commit revision; branches and tags are rejected.
    pub revision: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Limits apply with or without a recipe. Recipe serving settings replace the ordinary service parser settings.
pub struct Serving {
    #[serde(rename = "toolParser", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Native vLLM tool-call parser used when no recipe is declared. Empty omits the parser flag.
    pub tool_parser: String,
    #[serde(rename = "reasoningParser", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Native vLLM reasoning parser used when no recipe is declared. Empty omits the parser flag.
    pub reasoning_parser: String,
    #[serde(rename = "port")]
    #[schemars(default)]
    /// Inference listening port. Explicit publication must use this port.
    pub port: i64,
    #[serde(rename = "contextTokens")]
    #[schemars(default)]
    /// Maximum model context length in tokens.
    pub context_tokens: i64,
    #[serde(rename = "maxSequences")]
    #[schemars(default)]
    /// Maximum concurrent sequences.
    pub max_sequences: i64,
    #[serde(rename = "batchTokens")]
    #[schemars(default)]
    /// Maximum tokens in a scheduled batch.
    pub batch_tokens: i64,
    #[serde(rename = "speculativeTokens")]
    #[schemars(default)]
    /// MTP speculative tokens. Must be zero without a recipe.
    pub speculative_tokens: i64,
    #[serde(rename = "startupTimeoutSeconds")]
    #[schemars(default)]
    /// Seconds allowed for backend readiness before startup fails.
    pub startup_timeout_seconds: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Resident watchdog thresholds are validated before runtime creation. The parser also checks relationships between thresholds.
pub struct Memory {
    #[serde(rename = "gpuMemoryGiB", skip_serializing_if = "is_zero")]
    #[schemars(default)]
    /// Total GPU budget in GiB without a recipe. Must be omitted or zero with a recipe, which supplies its own byte budget.
    pub gpu_memory_gib: i64,
    #[serde(rename = "hostReserveGiB")]
    #[schemars(default)]
    /// Host memory reserve in GiB excluded from the serving budget.
    pub host_reserve_gib: i64,
    #[serde(rename = "kvCacheGiB")]
    #[schemars(default)]
    /// KV cache allocation in GiB for ordinary vLLM. Recipe serving does not emit this explicit cache-allocation flag.
    pub kv_cache_gib: i64,
    #[serde(rename = "minAvailableGiB")]
    #[schemars(default)]
    /// Available-memory threshold in GiB that contributes a low-memory sample.
    pub min_available_gib: i64,
    #[serde(rename = "minFreeGiB")]
    #[schemars(default)]
    /// Free-memory threshold in GiB, used when available memory is below freeGateGiB.
    pub min_free_gib: i64,
    #[serde(rename = "freeGateGiB")]
    #[schemars(default)]
    /// Available-memory gate in GiB for minFreeGiB. Must be at least minAvailableGiB after defaults.
    pub free_gate_gib: i64,
    #[serde(rename = "consecutiveSamples")]
    #[schemars(default)]
    /// Consecutive low-memory samples before the watchdog stops the owned process.
    pub consecutive_samples: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Execution host and Docker network for a remote model service.
pub struct ServicePlacement {
    /// Optional ownership declaration for the network configured by networkCIDR. Omission means managed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ManagedResource")]
    pub network: Option<super::ManagedResource>,
    /// SSH Docker endpoint, for example ssh://gpu-box.
    pub engine: String,
    /// Canonical private IPv4 /24 on the selected Docker engine.
    pub network_cidr: String,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// HTTP model publication must match the bind address, service port, and /v1 path.
pub struct ServicePublication {
    /// Private HTTP inference URL reachable by OpenShell.
    pub endpoint: String,
    /// Private host IPv4 address outside the service Docker subnet. Loopback is rejected.
    pub bind_address: String,
}
