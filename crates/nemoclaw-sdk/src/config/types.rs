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
    /// Immutable deployment UUID. Use a fresh UUID for a new deployment and retain it for later operations. Either case is accepted; NemoClaw stores it lowercase.
    pub uid: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// The configuration requires at least one named sandbox and at least one selected inference provider. Managed packages declared under services are installed independently of their consumers.
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
        skip_serializing_if = "std::collections::BTreeMap::is_empty"
    )]
    #[schemars(default)]
    /// Named inference definitions available to sandbox routes through providerRef. Unselected definitions create no resources or credential requirements.
    pub inference_providers: std::collections::BTreeMap<String, InferenceProvider>,
    #[serde(rename = "sandboxes")]
    /// Named sandboxes: one to 256 with a kubernetes or openshift gateway runtime, whose cluster schedules them, and one to 32 with docker or podman, which run every sandbox on one host. Each runs one agent through its selected Fabric adapter and attaches at most 32 providers, OpenShell's limit per sandbox: its selected inference providers, web search, and api integrations. Declaration order does not select a default sandbox or agent.
    pub sandboxes: std::collections::BTreeMap<String, Sandbox>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(default, length(max = 32))]
    /// Registries whose images NemoClaw pulls through Docker with the logins of the machine running OpenTofu, from its Docker configuration file. Lists addresses only; credentials stay in that file or its credential store.
    pub registries: Vec<Registry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// A registry NemoClaw authenticates to when pulling images through Docker.
pub struct Registry {
    #[schemars(length(min = 1, max = 253))]
    /// Registry address, such as nvcr.io or registry.example.com:5000, matching its entry in the Docker configuration file.
    pub address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String", length(min = 1, max = 4096))]
    /// Absolute path of the Docker configuration file that holds the login, on the machine running OpenTofu. Defaults to `.docker/config.json` in the user's home directory; `DOCKER_CONFIG` is not read.
    pub config_file: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Environment variable whose value is a bearer or API credential; the configuration holds no credential value.
pub struct SecretRef {
    #[serde(rename = "env")]
    /// Uppercase name of the caller environment variable that holds the credential. NEMOCLAW_KUBERNETES_STATE and the NEMOCLAW_MANAGED_K8S_, HELM_, KUBE_, and KUBERNETES_SERVICE_ prefixes are reserved for runtime controls.
    pub env: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Environment variable whose value is the path of a local file; the configuration holds neither the path nor the file.
pub struct FileRef {
    #[serde(rename = "env")]
    /// Uppercase name of the caller environment variable that holds the local file path. NEMOCLAW_KUBERNETES_STATE and the NEMOCLAW_MANAGED_K8S_, HELM_, KUBE_, and KUBERNETES_SERVICE_ prefixes are reserved for runtime controls.
    pub env: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Gateway TLS file references: the CA certificate that verifies the gateway, and a client certificate and key, which must appear together, when the gateway requires one.
pub struct TLS {
    #[serde(rename = "ca")]
    /// Environment variable whose value names the local CA certificate file.
    pub ca: FileRef,
    #[serde(rename = "certificate", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "FileRef")]
    /// Environment variable whose value names the local client certificate file. Requires key.
    pub certificate: Option<FileRef>,
    #[serde(rename = "key", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "FileRef")]
    /// Environment variable whose value names the local client private-key file. Requires certificate.
    pub key: Option<FileRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "management", rename_all = "lowercase")]
/// Install a local or explicitly configured Kubernetes gateway, or connect to an existing gateway.
pub enum Gateway {
    /// A gateway installed and managed by this deployment. The SDK pins its image.
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
/// Installation settings for a managed gateway. Without kubernetes, use a local Docker or rootless Linux Podman engine. Kubernetes requires an explicit existing-cluster target and the development authentication profile.
pub struct ManagedGateway {
    #[serde(rename = "runtime")]
    #[schemars(default)]
    /// Compute driver the gateway runs every sandbox with; omission selects Docker.
    pub runtime: Runtime,
    #[serde(rename = "endpoint")]
    #[schemars(default)]
    /// Local engine gateways use an HTTP origin with an unprivileged loopback port. Kubernetes requires `https://HOST:PORT` with an explicit nonzero port and no trailing slash. Providers forward free local ports of their own to the owned gateway. Without `kubernetes.expose`, the host is `127.0.0.1` and this port is not bound. With it, the endpoint is the lowercase DNS name or IPv4 address and port other clients dial, and the gateway certificate names its host.
    pub endpoint: String,
    #[serde(rename = "engine", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Managed local gateway Unix engine socket; Podman requires its API service socket. Excluded by kubernetes.
    pub engine: String,
    #[serde(
        rename = "imagePullPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "super::ImagePullPolicy")]
    /// Image acquisition before local container creation. Docker accepts IfNotPresent (the default) or Never; Podman also accepts Always before creation or restart. Excluded by kubernetes.
    pub image_pull_policy: Option<super::ImagePullPolicy>,
    #[serde(rename = "networkCIDR", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Canonical private IPv4 /24 for a managed local gateway. Excluded by kubernetes.
    pub network_cidr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::ManagedKubernetes")]
    /// Explicit Kubernetes provisioning target. Excludes local engine, imagePullPolicy, and networkCIDR settings and requires Kubernetes sandboxes without managed inference services.
    pub kubernetes: Option<Box<super::ManagedKubernetes>>,
    #[serde(rename = "config", skip_serializing_if = "Option::is_none")]
    #[schemars(default, extend("additionalProperties" = {"anyOf": [{"type": "object"}, {"type": "array", "items": {"type": "object"}}]}))]
    /// OpenShell gateway settings in the OpenShell Helm chart's gatewayConfig format: each key names a TOML table, such as openshell.drivers.docker, and holds its fields; nested maps are inline tables, and a list of maps is an array of tables. Docker and Podman gateways write it into the configuration file of each new gateway container, so a change replaces the container and keeps its data; Kubernetes passes it to the chart's gatewayConfig. OpenShell validates the settings; keys NemoClaw manages are rejected. Must not contain secrets.
    pub config: Option<crate::managed::gateway_config::GatewayConfig>,
    #[serde(rename = "policyAuthority", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "PolicyAuthority")]
    /// Who authors sandbox policy on this gateway; omission means NemoClaw does.
    pub policy_authority: Option<PolicyAuthority>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// The component that authors every sandbox's policy on a gateway, instead of NemoClaw.
pub struct PolicyAuthority {
    #[serde(rename = "apf")]
    /// APF's admission interceptor replaces each sandbox's policy with its signed bundle's, and APF serves the provider profiles. Sandboxes must not author an explicit policy; NemoClaw requires APF's provenance on each sandbox and treats a later change to the loaded policy as drift.
    pub apf: ApfPolicyAuthority,
}

impl PolicyAuthority {
    /// APF's connection settings, when NemoClaw registers APF with the gateway.
    pub fn managed(&self) -> Option<&ManagedApf> {
        match &self.apf {
            ApfPolicyAuthority::Managed(apf) => Some(apf),
            ApfPolicyAuthority::External(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "registration", rename_all = "lowercase")]
/// Who registers APF with the gateway as its interceptor and provider-profile source.
pub enum ApfPolicyAuthority {
    /// NemoClaw registers APF in a managed Docker gateway's configuration file.
    #[schemars(title = "Registered by NemoClaw")]
    Managed(ManagedApf),
    /// The gateway's operator registers APF, such as in spec.gateway.config. Required on an external gateway.
    #[schemars(title = "Registered by the gateway's operator")]
    External(ExternalApf),
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// APF's connection settings, which NemoClaw writes into the gateway's configuration. spec.gateway.config must not register interceptors or provider-profile sources.
pub struct ManagedApf {
    #[serde(rename = "endpoint")]
    /// APF's gRPC origin as the gateway reaches it: `https://HOST[:PORT]`, without a path.
    pub endpoint: String,
    #[serde(rename = "tls", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "InterceptorTls")]
    /// The CA certificate that verifies APF; omission uses the gateway's system roots.
    pub tls: Option<InterceptorTls>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// No settings: the operator's registration holds APF's connection.
pub struct ExternalApf {}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// TLS file reference for a service the gateway dials.
pub struct InterceptorTls {
    #[serde(rename = "ca")]
    /// Environment variable whose value names the local CA certificate file. NemoClaw copies the certificate into the gateway's storage.
    pub ca: FileRef,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Connection settings for an existing gateway. Credentials and TLS require HTTPS.
pub struct ExternalGateway {
    #[serde(rename = "runtime")]
    #[schemars(default)]
    /// Compute driver the existing gateway runs; omission selects Docker. Planning checks it against the driver the gateway reports.
    pub runtime: Runtime,
    /// Engine containing Docker or Podman sandbox images, used only for image metadata inspection. Required for their deployment planning; omission permits retained-state teardown. Kubernetes and OpenShift use image.metadata instead.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub engine: String,
    /// Gateway HTTP(S) origin, without a path.
    pub endpoint: String,
    #[serde(rename = "credential", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "SecretRef")]
    /// Optional bearer credential reference for an external HTTPS gateway.
    pub credential: Option<SecretRef>,
    #[serde(rename = "tls", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "TLS")]
    /// Optional TLS references for an external HTTPS gateway: a CA alone, or with a client certificate and key for mutual TLS.
    pub tls: Option<TLS>,
    #[serde(rename = "policyAuthority", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "PolicyAuthority")]
    /// Who authors sandbox policy on this gateway; omission means NemoClaw does.
    pub policy_authority: Option<PolicyAuthority>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Choose an endpoint for external inference or serviceRef for a managed service.
pub struct InferenceProvider {
    #[serde(rename = "provider")]
    /// OpenShell provider implementation. Must match the selected API family.
    pub provider: super::InferenceProviderKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::InferenceApi")]
    /// Request API. Omission selects anthropic-messages for Anthropic providers and openai-completions for OpenAI providers. NemoClaw uses it to read the endpoint's model catalog; agents use the protocol their adapter selects for the provider.
    pub api: Option<super::InferenceApi>,
    #[serde(default, rename = "endpoint", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Inference HTTP(S) URL owned outside the deployment. Required without serviceRef and excluded with serviceRef.
    #[schemars(extend("x-nemoclaw-required" = "Without serviceRef"))]
    pub endpoint: String,
    #[serde(rename = "credential", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "SecretRef")]
    /// Optional API credential reference for an external HTTPS endpoint. Excluded by serviceRef.
    pub credential: Option<SecretRef>,
    #[serde(
        rename = "serviceRef",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "String")]
    /// Name of a managed service in spec.services. Excludes endpoint and credential.
    pub service_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Inference definition owned by one route, with the fields of an inferenceProviders entry and its own name.
pub struct InlineInferenceProvider {
    #[serde(rename = "name")]
    /// Provider name. Must not shadow an enclosing definition.
    pub name: String,
    #[serde(flatten)]
    /// Connection settings, as in a named inference definition.
    pub definition: InferenceProvider,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// The gateway owns sandbox creation and dependency placement.
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
        skip_serializing_if = "std::collections::BTreeMap::is_empty"
    )]
    #[schemars(default)]
    /// Named inference definitions visible to this sandbox's routes through providerRef. Names must not shadow deployment definitions.
    pub inference_providers: std::collections::BTreeMap<String, InferenceProvider>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[schemars(default)]
    /// Named integration definitions selected by this sandbox's agent through integrationRefs. Names must not collide with deployment definitions.
    pub integrations: std::collections::BTreeMap<String, super::Integration>,
    #[serde(rename = "image")]
    #[schemars(default)]
    #[schemars(extend("x-nemoclaw-required" = "For Kubernetes sandboxes"))]
    /// Kubernetes requires an explicit immutable agent image compatible with the gateway's runtime user and group IDs. For other drivers, omission selects the generic SDK agent image pin; verify that it contains the selected Fabric adapter.
    pub image: Image,
    #[serde(rename = "network")]
    #[schemars(default)]
    /// Sandbox network policy; omission selects isolated egress with grants for declared inference.
    pub network: super::Network,
    #[serde(
        rename = "driverConfig",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "serde_json::Map<String, serde_json::Value>")]
    /// OpenShell's per-driver sandbox configuration, such as mounts, passed through unchanged. NemoClaw sets nothing in it; the gateway must allow driver configuration.
    pub driver_config: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(
        rename = "serviceExposures",
        default,
        skip_serializing_if = "std::collections::BTreeMap::is_empty"
    )]
    #[schemars(default)]
    /// OpenShell service exposures, keyed by service name: loopback ports in the sandbox that the gateway makes reachable at a URL it reports. OpenShell checks each name when it exposes the service. Changing them updates the running sandbox's endpoints in place.
    pub service_exposures: std::collections::BTreeMap<String, ServiceExposure>,
    #[serde(rename = "agent")]
    /// The configured agent hosted by this sandbox in one Fabric runtime. Deploy additional agents in separate sandboxes.
    pub agent: Agent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// One OpenShell service exposure: a loopback port the gateway makes reachable.
pub struct ServiceExposure {
    #[serde(rename = "targetPort")]
    #[schemars(range(min = 1, max = 65535))]
    /// Loopback TCP port the service listens on inside the sandbox.
    pub target_port: u16,
    #[serde(
        rename = "authorizationMode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "AuthorizationMode")]
    /// How OpenShell treats an incoming application Authorization header. Omission leaves OpenShell's default, STRIP.
    pub authorization_mode: Option<AuthorizationMode>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
/// OpenShell's service authorization modes.
pub enum AuthorizationMode {
    /// Remove the Authorization header before the request reaches the service.
    Strip,
    /// Pass a bearer Authorization header through to the service.
    BearerPassthrough,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Sandbox image identity.
pub struct Image {
    #[serde(rename = "ref")]
    #[schemars(default)]
    #[schemars(extend("x-nemoclaw-required" = "For Kubernetes sandboxes"))]
    /// Immutable image reference. Kubernetes and OpenShift require an explicit nonempty reference. For other drivers, omitted or empty selects the generic SDK agent image pin; verify that it contains the selected Fabric adapter.
    pub ref_: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "FileRef")]
    /// Environment reference to the absolute path of a local OCI metadata bundle for `ref`; required for Kubernetes and OpenShift, where no local engine can be inspected. Destroy does not read it. Its index, manifest, configuration, and Fabric catalog are verified against `ref` before use. The bundle holds no image layers or credentials. Docker and Podman inspect their engine instead.
    pub metadata: Option<FileRef>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// The compute driver an OpenShell gateway runs sandboxes with. One gateway runs one driver.
pub struct Runtime {
    #[serde(rename = "provider")]
    #[schemars(default)]
    /// Docker, Podman, Kubernetes, or OpenShift profile. Kubernetes and OpenShift require an external gateway or an explicit managed cluster target, and external inference endpoints. OpenShift uses the upstream Kubernetes driver with namespace-assigned identities. A managed service with Podman requires explicit service placement.
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
    /// Require API-key authentication through the selected routed provider. The provider must supply a credential.
    pub auth: Option<super::AgentAuth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentTools")]
    /// Explicit native tool identifiers projected into public Fabric configuration. Fabric validates adapter support; this does not change OS-level filesystem permissions.
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
    /// One or more uniquely named model choices. Fabric validates native multiple-model support.
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
    #[schemars(default, with = "InlineInferenceProvider")]
    /// Inline inference definition owned by this route. Excludes providerRef and must not shadow an enclosing definition.
    pub provider: Option<InlineInferenceProvider>,
    #[serde(rename = "overrides")]
    /// Model selection, shared limits, and optional native settings.
    pub overrides: Overrides,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Model settings for one named inference choice.
pub struct Overrides {
    #[serde(rename = "model")]
    /// Model identifier. For a managed service, match its served model: vLLM's recipe serving.modelName, serving.modelName, or model.repository; Ollama's model.name; an Ollama proxy's upstream.model.name.
    pub model: String,
    #[serde(flatten)]
    /// Shared public model limits. Native model settings belong in settings.
    pub tuning: super::RouteTuning,
    #[serde(
        rename = "harnessProvider",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "String")]
    /// Fabric model provider the harness uses, such as custom. Defaults to the inference provider's API family.
    pub harness_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "serde_json::Map<String, serde_json::Value>")]
    /// Opaque native model settings validated by Fabric's selected model schema.
    pub settings: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "serde_json::Map<String, serde_json::Value>")]
    /// Model fields the selected adapter declares as extensions, such as Pi's context_window; Fabric validates them.
    pub extensions: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// One harness runtime configuration. Every sandbox runs its own instance for its configured agent.
pub struct Harness {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "serde_json::Map<String, serde_json::Value>")]
    /// Public Fabric configuration. Deployment-owned identities and model connections cannot be overridden.
    pub config: Option<serde_json::Map<String, serde_json::Value>>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "serde_json::Map<String, serde_json::Value>")]
    /// Opaque native settings validated by the selected Fabric adapter.
    pub settings: Option<serde_json::Map<String, serde_json::Value>>,
    /// Fabric harness implementation for the sandbox agent.
    pub kind: super::HarnessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "super::AgentExecution")]
    /// Public Fabric runtime execution settings.
    pub execution: Option<super::AgentExecution>,
}
