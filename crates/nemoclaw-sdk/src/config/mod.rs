// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod agent_inference;
pub(crate) mod constraints;
#[doc(hidden)]
pub use nemoclaw_openshell::credential_metadata;
mod engine_endpoint;
pub use constraints::{GATEWAY_ENGINE, GATEWAY_PORT, GPU_DEVICE};
pub use engine_endpoint::{engine_socket, validate_engine_endpoint};
mod integrations;
pub use integrations::*;
pub use nemoclaw_openshell::search::search_policy;
mod inference;
mod providers;
pub(crate) mod references;
pub use references::NamedSandbox;
mod source;
mod yaml_source;
pub use crate::services::ServiceDefinition;
pub use agent_inference::*;
mod image_pull_policy;
pub use image_pull_policy::ImagePullPolicy;
pub use nemoclaw_openshell::policy::policy_json;
pub use nemoclaw_openshell::profile::definition as inference_profile;
mod network;
pub use network::*;
mod kinds;
mod kubernetes;
pub use kubernetes::*;
#[doc(hidden)]
pub mod schema;
pub use kinds::{ComputeDriver, HarnessKind, InferenceProviderKind};
mod types;
pub use inference::{InferenceConnection, InferenceTarget};
pub(crate) mod validation;
use sha2::{Digest, Sha256};
use std::io::Read;
pub use types::*;
pub use validation::{is_fabric_harness, valid_name, validate_endpoint, validate_endpoint_url};

pub const API_VERSION: &str = "nemoclaw.nvidia.com/v1alpha1";
pub const MAX_DOCUMENT_BYTES: u64 = 1 << 20;
pub use crate::artifact_pins::DEFAULT_GATEWAY_IMAGE;

/// Configuration diagnostics omit credentials and arbitrary source values.
pub use nemoclaw_runtime::config::ConfigError;

/// Parse a bounded YAML value without claiming it is a complete configuration.
/// Authoring can inspect sparse input before constructing a [`Document`].
pub fn parse_yaml_value(input: impl Read) -> Result<serde_json::Value, ConfigError> {
    read_yaml(input).map(|(_, tree)| tree)
}

fn read_yaml(input: impl Read) -> Result<(String, serde_json::Value), ConfigError> {
    let mut bytes = Vec::new();
    input
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ConfigError::new("cannot read configuration"))?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(ConfigError::new("configuration exceeds 1 MiB"));
    }
    let text =
        String::from_utf8(bytes).map_err(|_| ConfigError::new("configuration must be UTF-8"))?;
    yaml_source::validate_tags(&text)?;
    let mut options = serde_saphyr::Options::default();
    options.with_snippet = false;
    let mut budget = serde_saphyr::Budget::default();
    budget.max_aliases = 0;
    budget.max_anchors = 0;
    budget.max_merge_keys = 0;
    options.budget = Some(budget);
    options.merge_keys = serde_saphyr::MergeKeyPolicy::Error;
    options.reject_unsupported_tags = true;
    let tree =
        serde_saphyr::from_str_with_options(&text, options).map_err(yaml_source::syntax_error)?;
    Ok((text, tree))
}

impl Document {
    /// Read, default, and validate a configuration document.
    ///
    /// # Errors
    /// Returns an error for unreadable, oversized, malformed, or invalid input.
    pub fn parse(input: impl Read) -> Result<Self, ConfigError> {
        let (text, tree) = read_yaml(input)?;
        schema::validate_input(&tree, Some(&text))?;
        let mut document: Self = serde_json::from_value(tree).map_err(|_| {
            ConfigError::new("configuration contains an unknown field or invalid field type")
        })?;
        document.defaults();
        document.validate()?;
        Ok(document)
    }
    /// Serialize a valid configuration to YAML.
    ///
    /// # Errors
    /// Returns an error if validation or serialization fails.
    pub fn yaml(&self) -> Result<String, ConfigError> {
        self.validate()?;
        serde_saphyr::to_string(self)
            .map_err(|_| ConfigError::new("cannot serialize configuration"))
    }
    pub fn digest(&self) -> String {
        // Named declaration order is not deployment intent; retain authored order on export.
        let mut canonical = self.clone();
        for inference in canonical.spec.inferences.values_mut() {
            inference.routes.sort_by(|a, b| a.name.cmp(&b.name));
        }
        for sandbox in canonical.spec.sandboxes.values_mut() {
            for inference in sandbox
                .inferences
                .values_mut()
                .chain(sandbox.agent.inference.iter_mut())
            {
                inference.routes.sort_by(|a, b| a.name.cmp(&b.name));
            }
        }
        let json = serde_json::to_string(&canonical)
            .expect("configuration contains only serializable values")
            .replace('&', "\\u0026")
            .replace('<', "\\u003c")
            .replace('>', "\\u003e")
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029");
        hex(&Sha256::digest(json.as_bytes()))
    }
    pub fn workspace(&self) -> String {
        format!(
            "nc-{}",
            &hex(&Sha256::digest(self.metadata.uid.as_bytes()))[..16]
        )
    }
    /// Resolve the validated inference endpoint without probing it.
    ///
    /// # Errors
    /// Returns configuration or bridge resolution errors from `inference_connection`.
    pub fn inference_endpoint(&self) -> Result<String, ConfigError> {
        Ok(self.inference_connection()?.endpoint)
    }
    pub fn credential_names(&self) -> Vec<&str> {
        let g = &self.spec.gateway;
        let mut names = Vec::new();
        if let Some(kubernetes) = g.as_kubernetes() {
            names.extend(kubernetes.kubeconfig.iter().map(|file| file.env.as_str()));
            names.extend(kubernetes.environment.iter().map(String::as_str));
            names.extend(
                kubernetes
                    .authentication
                    .token
                    .as_ref()
                    .map(|token| token.env.as_str()),
            );
        }
        if let Some(c) = g.credential() {
            names.push(c.env.as_str());
        }
        if let Some(tls) = g.tls() {
            names.push(tls.ca.env.as_str());
            names.extend(tls.certificate.iter().map(|file| file.env.as_str()));
            names.extend(tls.key.iter().map(|file| file.env.as_str()));
        }
        if let Some(tls) = g.managed_apf().and_then(|apf| apf.tls.as_ref()) {
            names.push(tls.ca.env.as_str());
        }
        if let Ok(providers) = self.selected_inference_providers() {
            for provider in providers {
                if let Some(credential) = &provider.credential {
                    names.push(credential.env.as_str());
                }
            }
        }
        for sandbox in self.sandboxes() {
            if let Some(metadata) = &sandbox.definition.image.metadata {
                names.push(metadata.env.as_str());
            }
            for binding in sandbox
                .integration_bindings(&self.spec.integrations)
                .expect("validated integration references")
            {
                match binding.definition {
                    Integration::WebSearch(search) => names.push(&search.credential.env),
                    Integration::Api(api) => names.push(&api.credential.env),
                }
            }
        }
        names.sort_unstable();
        names.dedup();
        names
    }
    pub fn defaults(&mut self) {
        // Owners, names, and the default subnet derive from the UUID, so one
        // deployment keeps one identity whatever case its UUID was written in.
        self.metadata.uid.make_ascii_lowercase();
        if let Gateway::Managed(gateway) = &mut self.spec.gateway {
            // Podman's socket depends on the host user, so only Docker's has
            // a default.
            if let ManagedTarget::Docker(local) = &mut gateway.target {
                default_string(&mut local.engine, constraints::GATEWAY_ENGINE);
            }
            if let ManagedTarget::Docker(local) | ManagedTarget::Podman(local) = &mut gateway.target
            {
                if local.port == 0 {
                    local.port = constraints::GATEWAY_PORT;
                }
                default_string(
                    &mut local.network_cidr,
                    &format!(
                        "172.30.{}.0/24",
                        Sha256::digest(self.metadata.uid.as_bytes())[0]
                    ),
                );
            }
        }
        for service in self.spec.services.values_mut() {
            crate::services::defaults(service);
        }
    }
}
fn default_string(value: &mut String, default: &str) {
    if value.is_empty() {
        *value = default.into();
    }
}
/// Parse a private IPv4 /24 written as its network address in canonical form.
/// ipnet accepts octets with leading zeros, which Docker rejects, and networks
/// are compared as text, so one network must have one spelling.
pub(crate) fn private_network(cidr: &str) -> Option<ipnet::Ipv4Net> {
    let network = cidr.parse::<ipnet::Ipv4Net>().ok()?;
    (network.to_string() == cidr
        && network.addr().is_private()
        && network.prefix_len() == 24
        && network.addr() == network.network())
    .then_some(network)
}
pub(crate) fn bridge_address(cidr: &str) -> Result<String, ConfigError> {
    network_address(
        cidr,
        1,
        "invalid bridge network",
        "bridge address exceeds IPv4 range",
    )
}
pub(crate) fn gateway_address(cidr: &str) -> Result<String, ConfigError> {
    network_address(
        cidr,
        2,
        "invalid gateway network",
        "gateway address exceeds IPv4 range",
    )
}
fn network_address(
    cidr: &str,
    offset: u32,
    invalid: &'static str,
    overflow: &'static str,
) -> Result<String, ConfigError> {
    let network = cidr
        .parse::<ipnet::Ipv4Net>()
        .map_err(|_| ConfigError::new(invalid))?;
    let address = u32::from(network.network())
        .checked_add(offset)
        .ok_or_else(|| ConfigError::new(overflow))?;
    Ok(std::net::Ipv4Addr::from(address).to_string())
}
impl ManagedTarget {
    /// The compute driver a gateway at this target runs every sandbox with.
    pub fn compute_driver(&self) -> ComputeDriver {
        match self {
            Self::Docker(_) => ComputeDriver::Docker,
            Self::Podman(_) => ComputeDriver::Podman,
            Self::Kubernetes(_) => ComputeDriver::Kubernetes,
            Self::OpenShift(_) => ComputeDriver::OpenShift,
        }
    }
    /// The local engine settings of a Docker or Podman target.
    pub fn local(&self) -> Option<&LocalTarget> {
        match self {
            Self::Docker(local) | Self::Podman(local) => Some(local),
            Self::Kubernetes(_) | Self::OpenShift(_) => None,
        }
    }
    /// Mutable local engine settings of a Docker or Podman target.
    pub fn local_mut(&mut self) -> Option<&mut LocalTarget> {
        match self {
            Self::Docker(local) | Self::Podman(local) => Some(local),
            Self::Kubernetes(_) | Self::OpenShift(_) => None,
        }
    }
    /// The cluster settings of a Kubernetes or OpenShift target.
    pub fn cluster(&self) -> Option<&ManagedKubernetes> {
        match self {
            Self::Kubernetes(cluster) | Self::OpenShift(cluster) => Some(cluster),
            Self::Docker(_) | Self::Podman(_) => None,
        }
    }
    /// Mutable cluster settings of a Kubernetes or OpenShift target.
    pub fn cluster_mut(&mut self) -> Option<&mut ManagedKubernetes> {
        match self {
            Self::Kubernetes(cluster) | Self::OpenShift(cluster) => Some(cluster),
            Self::Docker(_) | Self::Podman(_) => None,
        }
    }
}
impl LocalTarget {
    /// The loopback origin the gateway serves at its port.
    pub fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}
impl ExternalTarget {
    /// The compute driver the existing gateway runs every sandbox with.
    pub fn compute_driver(&self) -> ComputeDriver {
        match self {
            Self::Docker(_) => ComputeDriver::Docker,
            Self::Podman(_) => ComputeDriver::Podman,
            Self::Kubernetes(_) => ComputeDriver::Kubernetes,
            Self::OpenShift(_) => ComputeDriver::OpenShift,
        }
    }
    /// The engine holding a Docker or Podman gateway's sandbox images, empty
    /// when the document names none.
    pub fn engine(&self) -> &str {
        match self {
            Self::Docker(engine) | Self::Podman(engine) => &engine.engine,
            Self::Kubernetes(_) | Self::OpenShift(_) => "",
        }
    }
}
impl ManagedGateway {
    /// The compute driver this gateway runs every sandbox with.
    pub fn compute_driver(&self) -> ComputeDriver {
        self.target.compute_driver()
    }
    /// The local engine settings of a Docker or Podman gateway.
    pub fn local(&self) -> Option<&LocalTarget> {
        self.target.local()
    }
    /// The cluster settings of a Kubernetes or OpenShift gateway.
    pub fn cluster(&self) -> Option<&ManagedKubernetes> {
        self.target.cluster()
    }
    /// The local engine socket of a Docker or Podman gateway, empty on a cluster.
    pub fn engine(&self) -> &str {
        self.local().map_or("", |local| &local.engine)
    }
    /// The private network of a Docker or Podman gateway, empty on a cluster.
    pub fn network_cidr(&self) -> &str {
        self.local().map_or("", |local| &local.network_cidr)
    }
    /// The image acquisition policy of a Docker or Podman gateway.
    pub fn image_pull_policy(&self) -> Option<ImagePullPolicy> {
        self.local().and_then(|local| local.image_pull_policy)
    }
    /// The address clients dial: a Docker or Podman gateway's loopback port,
    /// or a cluster gateway's published endpoint. A cluster gateway without
    /// `expose` has none; NemoClaw reaches it through a port forward.
    pub fn endpoint(&self) -> Option<String> {
        match &self.target {
            ManagedTarget::Docker(local) | ManagedTarget::Podman(local) => Some(local.endpoint()),
            ManagedTarget::Kubernetes(cluster) | ManagedTarget::OpenShift(cluster) => cluster
                .expose
                .as_ref()
                .map(|expose| expose.endpoint.clone()),
        }
    }
    /// These settings without the image acquisition policy, a mutable provider
    /// attribute rather than container identity.
    pub(crate) fn runtime_settings(&self) -> Self {
        let mut settings = self.clone();
        if let Some(local) = settings.target.local_mut() {
            local.image_pull_policy = None;
        }
        settings
    }
    /// Resolve the first address after the configured network address.
    ///
    /// # Errors
    /// Returns an error for malformed IPv4 CIDRs or an address overflow.
    pub fn bridge(&self) -> Result<String, ConfigError> {
        let local = self.local().ok_or(ConfigError::new(
            "Kubernetes gateways have no local engine bridge",
        ))?;
        bridge_address(&local.network_cidr)
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Gateway {
    /// The compute driver this gateway runs every sandbox with.
    pub fn compute_driver(&self) -> ComputeDriver {
        match self {
            Self::Managed(gateway) => gateway.compute_driver(),
            Self::External(gateway) => gateway.target.compute_driver(),
        }
    }
    /// Who authors sandbox policy on this gateway; `None` means NemoClaw does.
    pub fn policy_authority(&self) -> Option<&PolicyAuthority> {
        match self {
            Self::Managed(gateway) => gateway.policy_authority.as_ref(),
            Self::External(gateway) => gateway.policy_authority.as_ref(),
        }
    }
    /// APF's connection settings, when NemoClaw registers APF with this gateway.
    pub fn managed_apf(&self) -> Option<&ManagedApf> {
        self.policy_authority()?.managed()
    }
    /// The address clients dial: an existing gateway's endpoint, a managed
    /// Docker or Podman gateway's loopback port, or a managed cluster
    /// gateway's published endpoint. A managed cluster gateway without
    /// `expose` has none; NemoClaw reaches it through a port forward.
    pub fn endpoint(&self) -> Option<String> {
        match self {
            Self::Managed(gateway) => gateway.endpoint(),
            Self::External(gateway) => Some(gateway.endpoint.clone()),
        }
    }
    /// The engine NemoClaw inspects sandbox images on: a managed Docker or
    /// Podman gateway's, or the one an existing Docker or Podman gateway's
    /// document names. Empty on a cluster or when none is named.
    pub fn engine(&self) -> &str {
        match self {
            Self::Managed(gateway) => gateway.engine(),
            Self::External(gateway) => gateway.target.engine(),
        }
    }
    /// Installation settings, when this deployment manages the gateway.
    pub fn as_managed(&self) -> Option<&ManagedGateway> {
        match self {
            Self::Managed(gateway) => Some(gateway),
            Self::External(_) => None,
        }
    }
    /// Existing-cluster settings for a managed Kubernetes or OpenShift gateway.
    pub fn as_kubernetes(&self) -> Option<&ManagedKubernetes> {
        self.as_managed().and_then(ManagedGateway::cluster)
    }
    /// Local Docker or Podman installation settings; excludes cluster targets.
    pub fn as_local_managed(&self) -> Option<&ManagedGateway> {
        self.as_managed()
            .filter(|gateway| gateway.local().is_some())
    }
    /// Mutable installation settings, when this deployment manages the gateway.
    pub fn as_managed_mut(&mut self) -> Option<&mut ManagedGateway> {
        match self {
            Self::Managed(gateway) => Some(gateway),
            Self::External(_) => None,
        }
    }
    pub(crate) fn managed(&self) -> Result<&ManagedGateway, ConfigError> {
        self.as_local_managed().ok_or(ConfigError::new(
            "operation requires a managed local gateway",
        ))
    }
    pub fn credential(&self) -> Option<&SecretRef> {
        match self {
            Self::Managed(_) => None,
            Self::External(gateway) => gateway.credential.as_ref(),
        }
    }
    pub fn tls(&self) -> Option<&TLS> {
        match self {
            Self::Managed(_) => None,
            Self::External(gateway) => gateway.tls.as_ref(),
        }
    }
    /// Settings to reach this gateway's API.
    pub fn connection(&self) -> nemoclaw_openshell::Connection {
        nemoclaw_openshell::Connection {
            endpoint: self.endpoint().unwrap_or_default(),
            credential_env: self.credential().map(|credential| credential.env.clone()),
            tls: self.tls().map(|tls| nemoclaw_openshell::TlsFiles {
                ca_env: tls.ca.env.clone(),
                identity: tls.certificate.as_ref().zip(tls.key.as_ref()).map(
                    |(certificate, key)| nemoclaw_openshell::IdentityFiles {
                        certificate_env: certificate.env.clone(),
                        key_env: key.env.clone(),
                    },
                ),
            }),
        }
    }
}
