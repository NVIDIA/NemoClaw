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
/// The configuration requires one to 32 named sandboxes and at least one selected inference provider. At most one selected provider may have managed inference dependencies.
pub struct Spec {
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[schemars(default)]
    /// Named harness configurations available through harnessRef. Selecting a definition reuses configuration; runtime processes belong to each sandbox.
    pub harnesses: std::collections::BTreeMap<String, Harness>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[schemars(default)]
    /// Named inference configurations available through inferenceRef. Definitions resolve providers in their own scope and create no resources until selected.
    pub inferences: std::collections::BTreeMap<String, Inference>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[schemars(default)]
    /// Named integration definitions shared by agents through integrationRefs. Definitions alone grant no access.
    pub integrations: std::collections::BTreeMap<String, super::Integration>,
    #[serde(rename = "gateway")]
    /// OpenShell gateway connection or managed gateway settings.
    pub gateway: Gateway,
    #[serde(
        rename = "inferenceProviders",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    #[schemars(default)]
    /// Named inference definitions available to sandbox routes. Unselected definitions create no resources or credential requirements.
    pub inference_providers: Vec<InferenceProvider>,
    #[serde(rename = "sandboxes")]
    /// One to 32 uniquely named sandboxes. Each selects one harness: one or more OpenClaw agents sharing a runtime, or one agent of another harness. Declaration order does not select a default sandbox or agent.
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
    #[serde(
        rename = "ollamaProxy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "super::OllamaProxy")]
    /// Manage an authenticated proxy while leaving the endpoint's Ollama daemon and installed model external.
    pub ollama_proxy: Option<super::OllamaProxy>,
    /// Optional server ownership. Omission means managed with service or ollama, external with endpoint alone. The OpenShell provider registration remains deployment-owned in either mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::Management")]
    pub management: Option<super::Management>,
    #[serde(rename = "name")]
    /// Provider name referenced by model choices.
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
/// The gateway owns sandbox creation. OpenClaw and Hermes accept managed gateway or inference dependencies.
pub struct Sandbox {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Harness")]
    /// Inline harness configuration. Exactly one of harness or harnessRef is required. Every agent in the sandbox is an instance of this harness implementation.
    pub harness: Option<Harness>,
    #[serde(
        rename = "harnessRef",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "String")]
    /// Name of a visible harness configuration. Excludes inline harness.
    pub harness_ref: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[schemars(default)]
    /// Named harness configurations available through harnessRef. Selecting a definition reuses configuration; runtime processes belong to each sandbox.
    pub harnesses: std::collections::BTreeMap<String, Harness>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[schemars(default)]
    /// Named inference configurations available through inferenceRef. Definitions resolve providers in their own scope and create no resources until selected.
    pub inferences: std::collections::BTreeMap<String, Inference>,
    #[serde(
        rename = "inferenceProviders",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    #[schemars(default)]
    /// Named inference definitions visible to this sandbox's routes. Names must not shadow deployment definitions.
    pub inference_providers: Vec<InferenceProvider>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[schemars(default)]
    /// Named integration definitions selected by this sandbox's agents through integrationRefs. Names must not collide with deployment definitions.
    pub integrations: std::collections::BTreeMap<String, super::Integration>,
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
    /// Sandbox network policy; omission selects isolated egress with grants for declared inference.
    pub network: Network,
    #[serde(rename = "agents")]
    /// Instances of the sandbox-selected harness. OpenClaw supports multiple named agents sharing one runtime process; other harnesses require one agent.
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
/// One agent instance with its own inference choices, tools, and integrations.
pub struct Agent {
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[schemars(default)]
    /// Named integration definitions attached directly to this agent. Names must not collide with definitions in enclosing scopes.
    pub integrations: std::collections::BTreeMap<String, super::Integration>,
    #[serde(
        default,
        rename = "integrationRefs",
        skip_serializing_if = "Vec::is_empty"
    )]
    #[schemars(default)]
    /// Unique integration names selected from spec.integrations or this sandbox's integrations. Omission selects no enclosing definitions.
    pub integration_refs: Vec<String>,
    #[serde(rename = "name")]
    /// Lowercase agent name.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Inference")]
    /// Inline inference configuration. Exactly one of inference or inferenceRef is required.
    pub inference: Option<Inference>,
    #[serde(
        rename = "inferenceRef",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "String")]
    /// Name of an enclosing inference configuration. Excludes inline inference.
    pub inference_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentAuth")]
    /// Hermes API-key authentication through the routed provider. The provider must declare a credential reference.
    pub auth: Option<super::AgentAuth>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    /// Initial model choice by route name. Required with multiple routes; omission selects the sole route.
    pub default: Option<String>,
    #[serde(rename = "routes")]
    /// One or more uniquely named model choices. Multiple choices require OpenClaw.
    pub routes: Vec<Route>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Native model connection authorized through an attached OpenShell provider.
pub struct Route {
    #[serde(rename = "name")]
    /// Unique lowercase name for this model choice.
    pub name: String,
    #[serde(
        rename = "providerRef",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "String")]
    /// Name of an enclosing inference provider. Exactly one of providerRef or provider is required.
    pub provider_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "InferenceProvider")]
    /// Inline inference definition owned by this route. Excludes providerRef and must not shadow an enclosing definition.
    pub provider: Option<InferenceProvider>,
    #[serde(rename = "overrides")]
    /// Model selection, optional OpenClaw tuning, and optional Pi model metadata.
    pub overrides: Overrides,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Model settings for one named inference choice.
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
    /// Optional single NVIDIA GPU requirements on Linux AMD64 with dedicated GPU memory. Omission keeps the existing Spark or inline-recipe host contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ServiceHardware")]
    pub hardware: Option<super::ServiceHardware>,
    /// Optional managed container IPC and shared-memory settings. Omission uses private IPC and 8 GiB of shared memory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ServiceContainer")]
    pub container: Option<super::ServiceContainer>,
    /// Optional native bearer authentication. The runtime generates and retains the key; omission preserves unauthenticated serving.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServiceAuthentication")]
    pub authentication: Option<ServiceAuthentication>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
/// Generated bearer authentication for a managed inference service.
pub enum ServiceAuthentication {
    Bearer,
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
    /// Optional advertised model name without a recipe. Omission uses the model repository; routes must match the advertised name.
    #[serde(rename = "modelName", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub model_name: String,
    /// Native Mamba backend without a recipe. Empty uses vLLM's default; flashinfer selects the pinned image's FlashInfer backend.
    #[serde(rename = "mambaBackend", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub mamba_backend: String,
    /// Without a recipe, omission or true enables eager execution; false leaves compilation and CUDA graphs at vLLM's native defaults.
    #[serde(rename = "enforceEager", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "bool")]
    pub enforce_eager: Option<bool>,
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
    /// Optional fraction of observed dedicated GPU memory, from 0.05 through 0.95. Requires service.hardware and excludes a recipe, gpuMemoryGiB and explicit KV-cache allocation; vLLM sizes its cache natively.
    #[serde(
        rename = "gpuMemoryUtilization",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "f64")]
    pub gpu_memory_utilization: Option<serde_json::Number>,
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
    /// KV cache allocation in GiB for ordinary vLLM. Omitted or zero defaults to 8, except gpuMemoryUtilization requires zero and lets vLLM allocate its cache. Recipe serving does not emit this flag.
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

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// One harness runtime configuration. Every sandbox runs its own instance; agents within a sandbox share its settings.
pub struct Harness {
    /// Fabric harness implementation. Multiple agents require OpenClaw.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentObservability")]
    /// Harness-native tracing shared by the sandbox.
    pub observability: Option<super::AgentObservability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentExecution")]
    /// OpenClaw timeout and heartbeat defaults shared by the sandbox.
    pub execution: Option<super::AgentExecution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentInterfaces")]
    /// Native dashboard access for this sandbox runtime.
    pub interfaces: Option<super::AgentInterfaces>,
}
