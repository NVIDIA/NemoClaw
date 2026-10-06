// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image-owned applications use the same compute compiler as typed inference services.
use crate::{
    Error,
    compile::{Generations, Target},
    config::{ConfigError, Document, ImagePullPolicy, validation::require},
    managed::{Process, Spec, Storage},
    services::contract::{InstallPlan, Installer, RemovePlan},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
pub mod inputs;

pub const SERVICE_KIND: &str = "container_service";
pub const STORAGE_KIND: &str = "container_storage";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// An ordinary Docker application, not an OpenShell sandbox or inference provider.
pub struct Service {
    /// Immutable application image. The image owns its entrypoint, CMD, and HEALTHCHECK.
    pub image: String,
    /// Omission selects IfNotPresent. Never requires an image in the selected engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ImagePullPolicy")]
    pub image_pull_policy: Option<ImagePullPolicy>,
    /// Linux image architecture: arm64 or amd64. This does not select a host architecture.
    pub architecture: String,
    /// Numeric non-root UID:GID. Omission selects 65532:65532.
    #[serde(default = "default_user")]
    pub user: String,
    /// Literal non-secret application settings. Credentials must not be supplied here.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, String>,
    /// Explicit preloaded immutable setup image; required when protected inputs are declared. No caller-supplied setup commands are accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_setup: Option<inputs::InputSetup>,
    /// Protected token references. Setup publishes root-confined files before dependent application startup.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub secrets: BTreeMap<String, inputs::ProtectedCredential>,
    /// Explicit connection projection and selected-agent readiness ordering.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agent_connections: BTreeMap<String, inputs::AgentConnection>,
    /// Local Docker placement. Omission inherits the managed Docker gateway's engine and network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ContainerPlacement")]
    pub placement: Option<ContainerPlacement>,
    /// Optional loopback or private IPv4 TCP publication. Omission publishes no port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ContainerPublication")]
    pub publication: Option<ContainerPublication>,
    /// Disposable application data. Destroy removes this volume; external data is not mounted.
    pub data: ContainerData,
    /// Apply-time observation of the image-owned Docker HEALTHCHECK; no mutation or task invocation.
    #[serde(default)]
    pub readiness: ContainerReadiness,
    /// Declared services that must be ready before this container starts. This injects no settings.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
}
fn default_user() -> String {
    "65532:65532".into()
}
fn startup_timeout() -> u64 {
    300
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Local Docker engine and application network. Remote engines are not qualified here.
pub struct ContainerPlacement {
    /// Local Unix Docker socket endpoint. TCP and SSH endpoints are rejected.
    pub engine: String,
    /// Canonical private IPv4 /24. Services sharing an engine must use the same network.
    #[serde(rename = "networkCIDR")]
    pub network_cidr: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One application TCP listener, independent of inference URL conventions.
pub struct ContainerPublication {
    /// Loopback or private host IPv4 address; public and wildcard addresses are rejected by SDK validation.
    pub bind_address: String,
    /// Same unprivileged TCP port inside the container and on the selected host.
    pub port: u16,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// An owned disposable data volume. The image must supply the writable non-root mount directory.
pub struct ContainerData {
    /// One canonical application directory below /var/lib, owned by the image's non-root user.
    pub mount_path: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Apply observes Docker health only while this bounded startup wait is active.
pub struct ContainerReadiness {
    /// Bounded startup wait, 1–3600 seconds. Omission selects 300 seconds.
    #[serde(default = "startup_timeout")]
    pub startup_timeout_seconds: u64,
}
impl Default for ContainerReadiness {
    fn default() -> Self {
        Self {
            startup_timeout_seconds: startup_timeout(),
        }
    }
}

pub(crate) fn constrain_schema(defs: &mut serde_json::Map<String, serde_json::Value>) {
    use crate::config::{constraints as c, schema::validation::property};
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|variant| variant["properties"]["kind"]["const"] == "container")
        .unwrap();
    property(service, "image", json!({"pattern":c::IMAGE}));
    property(service, "architecture", json!({"enum":["arm64","amd64"]}));
    property(
        service,
        "user",
        json!({"pattern":"^[1-9][0-9]{0,8}:[1-9][0-9]{0,8}$", "default":"65532:65532"}),
    );
    property(
        service,
        "environment",
        json!({"maxProperties":128,"propertyNames":{"pattern":c::ENV},"additionalProperties":{"type":"string","maxLength":65536,"pattern":"^[^\\u0000]*$(?![\\s\\S])"}}),
    );
    property(
        service,
        "dependsOn",
        json!({"maxItems":128,"uniqueItems":true,"items":{"type":"string","pattern":c::SLUG}}),
    );
    property(
        &mut defs["ContainerData"],
        "mountPath",
        json!({"pattern":"^/var/lib/[a-z][a-z0-9-]{0,62}$"}),
    );
    property(
        &mut defs["ContainerReadiness"],
        "startupTimeoutSeconds",
        json!({"minimum":1,"maximum":3600,"default":300}),
    );
    property(
        &mut defs["ContainerPublication"],
        "port",
        json!({"minimum":1024,"maximum":65535}),
    );
    property(
        &mut defs["ContainerPublication"],
        "bindAddress",
        json!({"format":"ipv4"}),
    );
    property(
        &mut defs["ContainerPlacement"],
        "engine",
        json!({"pattern":"^unix:///"}),
    );
}

impl Service {
    pub fn validate(&self) -> Result<(), ConfigError> {
        crate::config::schema::validate_service("container", self)?;
        require(
            self.input_setup.is_some()
                == (!self.secrets.is_empty() || !self.agent_connections.is_empty()),
            "inputSetup is required exactly when protected inputs are declared",
        )?;
        if let Some(setup) = &self.input_setup {
            setup.validate()?;
        }
        inputs::validate_inputs(
            &self.data.mount_path,
            &self.secrets,
            &self.agent_connections,
        )?;
        require(
            self.environment.values().map(String::len).sum::<usize>() <= 128 << 10,
            "container environment exceeds its size limit",
        )?;
        if let Some(publication) = &self.publication {
            let ip: std::net::Ipv4Addr = publication
                .bind_address
                .parse()
                .map_err(|_| ConfigError::new("invalid container publication address"))?;
            require(
                ip.is_loopback() || ip.is_private(),
                "container publication requires a loopback or private IPv4 address",
            )?;
        }
        if let Some(placement) = &self.placement {
            require(
                placement.engine.starts_with("unix:///")
                    && crate::config::validate_engine_endpoint(&placement.engine).is_ok(),
                "container placement requires a local Docker socket",
            )?;
            let net: ipnet::Ipv4Net = placement
                .network_cidr
                .parse()
                .map_err(|_| ConfigError::new("invalid container network"))?;
            require(
                net.addr().is_private() && net.prefix_len() == 24 && net.addr() == net.network(),
                "container network requires a canonical private IPv4 /24",
            )?;
        }
        Ok(())
    }
    pub(crate) fn location(&self, document: &Document) -> Result<(String, String), ConfigError> {
        if let Some(placement) = &self.placement {
            return Ok((placement.engine.clone(), placement.network_cidr.clone()));
        }
        require(
            document.spec.gateway.runtime().provider == crate::config::ComputeDriver::Docker,
            "container requires a managed Docker gateway or explicit local Docker placement",
        )?;
        let gateway = document.spec.gateway.managed()?;
        require(
            gateway.engine.starts_with("unix:///"),
            "container requires a local Docker engine",
        )?;
        Ok((gateway.engine.clone(), gateway.network_cidr.clone()))
    }
}
fn address(kind: &str, name: &str) -> String {
    format!("nemoclaw_{kind}.{name}")
}

impl Installer for Service {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        self.validate()?;
        let generation = generations
            .get(SERVICE_KIND)
            .filter(|value| !value.is_empty())
            .ok_or(Error::State("missing container service generation"))?;
        let (engine, network_cidr) = self.location(document)?;
        let shared_gateway = document.spec.gateway.as_managed().filter(|gateway| {
            gateway.engine == engine
                && gateway.network_cidr == network_cidr
                && gateway.runtime.provider == crate::config::ComputeDriver::Docker
        });
        let process = Process {
            engine: engine.clone(),
            image: self.image.clone(),
            network_cidr,
            create_network: shared_gateway.is_none(),
            architecture: self.architecture.clone(),
            image_labels: BTreeMap::new(),
            pull_image: false,
            image_pull_policy: None,
            configuration: String::new(),
            entrypoint: Vec::new(),
            command: Vec::new(),
            user: self.user.clone(),
            environment: self.environment.clone(),
            input_revision: inputs::input_revision(
                &self.user,
                &self.data.mount_path,
                &self.secrets,
                &self.agent_connections,
            ),
            mount_target: self.data.mount_path.clone(),
            bind_address: self
                .publication
                .as_ref()
                .map_or(String::new(), |p| p.bind_address.clone()),
            port: self.publication.as_ref().map_or(0, |p| p.port),
            shared_memory_bytes: 64 << 20,
            host_ipc: false,
            memory_bytes: 1 << 30,
            gpu: false,
        };
        let spec = Spec {
            layout: 0,
            compute_driver: crate::config::ComputeDriver::Docker,
            kind: SERVICE_KIND.into(),
            name: format!("{}-container-{name}", document.workspace()),
            owner: document.metadata.uid.clone(),
            generation: generation.clone(),
            gateway: shared_gateway
                .map_or_else(Default::default, |gateway| gateway.runtime_settings()),
            process: Some(process),
        };
        let storage = Storage {
            name: spec.volume(),
            owner: spec.owner.clone(),
            generation: generation.clone(),
            engine,
        };
        let mut values = crate::backend::Row::from([
            ("spec".into(), spec.json()?),
            (
                "wait_timeout_seconds".into(),
                self.readiness.startup_timeout_seconds.to_string(),
            ),
        ]);
        if let Some(policy) = self.image_pull_policy {
            values.insert("image_pull_policy".into(), policy.as_str().into());
        }
        let mut dependencies = vec![address(STORAGE_KIND, name)];
        for dependency in &self.depends_on {
            match &document.spec.services[dependency] {
                super::super::ServiceDefinition::Container(_) => dependencies.push(format!(
                    "data.nemoclaw_service_readiness.{SERVICE_KIND}_{dependency}"
                )),
                super::super::ServiceDefinition::OllamaProxy(_) => dependencies.push(format!(
                    "data.nemoclaw_service_readiness.ollama_proxy_{dependency}"
                )),
                // Runtime-stage inference is ready before the deployment graph executes.
                super::super::ServiceDefinition::Ollama(_)
                | super::super::ServiceDefinition::Vllm(_) => {}
            }
        }
        let mut targets = vec![
            Target {
                kind: STORAGE_KIND.into(),
                address: address(STORAGE_KIND, name),
                values: crate::backend::Row::from([("spec".into(), storage.json()?)]),
            },
            Target {
                kind: SERVICE_KIND.into(),
                address: address(SERVICE_KIND, name),
                values,
            },
        ];
        let mut edges = BTreeMap::new();
        for connection in self.agent_connections.values() {
            connection.validate_binding(document)?;
            dependencies.push(format!(
                "data.nemoclaw_sandbox_readiness.{}",
                connection.sandbox_ref
            ));
        }
        if !self.secrets.is_empty() || !self.agent_connections.is_empty() {
            let input_address = address(inputs::INPUTS_KIND, name);
            let inputs = inputs::InputsSpec {
                process: spec.clone(),
                setup: self
                    .input_setup
                    .clone()
                    .ok_or(Error::State("missing protected input setup image"))?,
                service: name.into(),
                workspace: document.workspace(),
                secrets: self.secrets.clone(),
                connections: self.agent_connections.clone(),
            };
            inputs.validate()?;
            targets.push(Target {
                kind: inputs::INPUTS_KIND.into(),
                address: input_address.clone(),
                values: crate::backend::Row::from([
                    (
                        "spec".into(),
                        serde_json::to_string(&inputs)
                            .map_err(|_| Error::State("invalid application inputs"))?,
                    ),
                    (
                        "sandbox_id".into(),
                        self.agent_connections.values().next().map_or_else(
                            || "none".into(),
                            |connection| {
                                format!("${{nemoclaw_sandbox.{}.id}}", connection.sandbox_ref)
                            },
                        ),
                    ),
                ]),
            });
            edges.insert(input_address.clone(), vec![address(STORAGE_KIND, name)]);
            dependencies.push(input_address);
        }
        edges.insert(address(SERVICE_KIND, name), dependencies);
        Ok(InstallPlan {
            targets,
            dependencies: edges,
        })
    }
    fn remove(&self, _: &Document, _: &str, _: &Generations) -> Result<RemovePlan, Error> {
        Ok(RemovePlan::default())
    }
}
