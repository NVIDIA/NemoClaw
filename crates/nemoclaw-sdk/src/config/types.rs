// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::ServiceDefinition;
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
/// The configuration requires one to 32 named sandboxes and at least one selected inference provider. Managed packages declared under services are installed independently of their consumers.
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
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[schemars(default)]
    /// Named managed container services to install, verify once, and remove during destroy. Inference providers may consume their connection through serviceRef.
    pub services: std::collections::BTreeMap<String, ServiceDefinition>,
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
    /// One to 32 uniquely named sandboxes. Each selects one harness: one or more OpenClaw or Deep Agents instances, or one agent of another harness. Declaration order does not select a default sandbox or agent.
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "management", rename_all = "lowercase")]
/// Install a local gateway or connect to an existing gateway.
pub enum Gateway {
    /// A gateway installed and managed by this deployment.
    /// Managed Podman targets local rootless Linux; rootful, remote, and other platforms are unqualified.
    #[schemars(title = "Managed gateway")]
    Managed(ManagedGateway),
    /// An existing gateway managed outside this deployment.
    #[schemars(title = "External gateway")]
    External(ExternalGateway),
}

impl Default for Gateway {
    fn default() -> Self {
        Self::External(ExternalGateway::default())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Managed Podman targets local rootless Linux; rootful, remote, and other platforms are unqualified.
/// Installation settings for a managed local gateway.
pub struct ManagedGateway {
    #[serde(rename = "endpoint")]
    #[schemars(default)]
    /// Local gateway HTTP origin with an unprivileged loopback port.
    pub endpoint: String,
    #[serde(rename = "engine", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Managed gateway Unix engine socket; Podman requires its API service socket.
    pub engine: String,
    #[serde(rename = "image", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Managed gateway image pinned by the SDK.
    pub image: String,
    #[serde(
        rename = "imagePullPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "super::ImagePullPolicy")]
    /// Image acquisition before container creation. Docker accepts IfNotPresent (the default) or Never; Podman also accepts Always before creation or restart.
    pub image_pull_policy: Option<super::ImagePullPolicy>,
    #[serde(rename = "networkCIDR", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Canonical private IPv4 /24 for a managed gateway.
    pub network_cidr: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Connection settings for an existing gateway. Credentials and TLS require HTTPS.
pub struct ExternalGateway {
    /// Gateway HTTP(S) origin, without a path.
    pub endpoint: String,
    #[serde(rename = "credential", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Credential")]
    /// Optional bearer credential reference for an external HTTPS gateway.
    pub credential: Option<Credential>,
    #[serde(rename = "tls", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "TLS")]
    /// Optional mutual TLS references for an external HTTPS gateway.
    pub tls: Option<TLS>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Choose an endpoint for external inference or serviceRef for a managed service.
pub struct InferenceProvider {
    #[serde(rename = "name")]
    /// Provider name referenced by model choices.
    pub name: String,
    #[serde(rename = "provider")]
    /// OpenShell provider implementation. Must match the selected API family.
    pub provider: super::InferenceProviderKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::InferenceApi")]
    /// Request API. Omission selects anthropic-messages for Claude, openai-responses for Codex, and openai-completions for other non-Pi harnesses. Pi requires omission and selects its API through native model metadata.
    pub api: Option<super::InferenceApi>,
    #[serde(default, rename = "endpoint", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Inference HTTP(S) URL owned outside the deployment. Required without serviceRef and excluded with serviceRef.
    #[schemars(extend("x-nemoclaw-required" = "Without serviceRef"))]
    pub endpoint: String,
    #[serde(rename = "credential", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Credential")]
    /// Optional API credential reference for an external HTTPS endpoint. Excluded by serviceRef.
    pub credential: Option<Credential>,
    #[serde(
        rename = "serviceRef",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "String")]
    /// Name of a managed service in spec.services. Excludes endpoint and credential.
    pub service_ref: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// The gateway owns sandbox creation. OpenClaw and Hermes accept managed gateway or inference dependencies.
pub struct Sandbox {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Harness")]
    /// Inline harness configuration. Exactly one of harness or harnessRef is required. The sandbox agent uses this harness implementation.
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
    /// Named integration definitions selected by this sandbox's agent through integrationRefs. Names must not collide with deployment definitions.
    pub integrations: std::collections::BTreeMap<String, super::Integration>,
    #[serde(rename = "name")]
    /// Lowercase sandbox name.
    pub name: String,
    #[serde(rename = "image")]
    #[schemars(default)]
    /// Sandbox agent image; omission selects the SDK pin for the selected harness.
    pub image: Image,
    #[serde(rename = "runtime")]
    #[schemars(default)]
    /// Sandbox driver; omission selects Docker. Every sandbox on a managed gateway must select the same driver.
    pub runtime: Runtime,
    #[serde(rename = "network")]
    #[schemars(default)]
    /// Sandbox network policy; omission selects isolated egress with grants for declared inference.
    pub network: super::Network,
    #[serde(rename = "agent")]
    /// The configured agent hosted by this sandbox in one Fabric runtime. Deploy additional agents in separate sandboxes.
    pub agent: Agent,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Sandbox image identity.
pub struct Image {
    #[serde(rename = "ref")]
    #[schemars(default)]
    /// Immutable image reference. Omitted or empty selects the SDK pin for the selected harness.
    pub ref_: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Sandbox runtime selected through OpenShell.
pub struct Runtime {
    #[serde(rename = "provider", deserialize_with = "super::kinds::runtime_driver")]
    #[schemars(default)]
    /// Docker or Podman driver. A managed service with Podman requires explicit service placement.
    pub provider: super::ComputeDriver,
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
    /// Read-only tools for OpenClaw, Deep Agents, or Pi, or OpenClaw disclosure mode. Omission preserves native defaults. allow: [read] restricts tools, not OS-level filesystem access.
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
    /// One or more uniquely named model choices. Multiple choices require OpenClaw or Pi.
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// One harness runtime configuration. Every sandbox runs its own instance for its configured agent.
pub struct Harness {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "serde_json::Map<String, serde_json::Value>")]
    /// Opaque native settings validated by the selected Fabric adapter.
    pub settings: Option<serde_json::Map<String, serde_json::Value>>,
    /// Fabric harness implementation for the sandbox agent.
    pub kind: super::HarnessKind,
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
