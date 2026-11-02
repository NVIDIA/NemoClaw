// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::config::ComputeDriver;
#[cfg(test)]
#[path = "spec_tests.rs"]
mod tests;

use crate::{Error, config::ManagedGateway};
use bollard_stubs::models::ContainerCreateBody;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
pub const GATEWAY_KIND: &str = "managed_gateway";
use super::GATEWAY_STORAGE_KIND;
pub use nemoclaw_docker::{GENERATION_LABEL, OWNER_LABEL};
pub const SPEC_LABEL: &str = "nemoclaw.nvidia.com/runtime-spec";
pub use crate::artifact_pins::SANDBOX_RUNTIME_IMAGE;
pub use crate::artifact_pins::SUPERVISOR_IMAGE;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    #[serde(default, skip_serializing_if = "is_zero")]
    pub layout: u32,
    #[serde(default, skip_serializing_if = "is_docker_driver")]
    pub compute_driver: ComputeDriver,
    pub kind: String,
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub gateway: ManagedGateway,
    /// The managed gateway's image, pinned by the SDK; services carry theirs in `process`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub image: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<Process>,
}

/// Package-neutral container process compiled by a service installer.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Process {
    pub engine: String,
    pub image: String,
    pub network_cidr: String,
    pub create_network: bool,
    pub architecture: String,
    #[serde(default)]
    pub image_labels: std::collections::BTreeMap<String, String>,
    pub pull_image: bool,
    /// Mutable acquisition policy supplied by the provider, excluded from identity.
    #[serde(skip)]
    pub image_pull_policy: Option<crate::config::ImagePullPolicy>,
    pub configuration: String,
    pub entrypoint: Vec<String>,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_owned: Option<ImageLaunch>,
    pub mount_target: String,
    pub bind_address: String,
    pub port: u16,
    pub shared_memory_bytes: u64,
    pub host_ipc: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_limit_millis: Option<u32>,
    pub memory_bytes: u64,
    pub gpu: bool,
    /// With `gpu`, the one GPU to expose instead of every GPU.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_device: Option<String>,
}

/// Launch settings when the image owns its entrypoint, command, and health check.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageLaunch {
    pub user: String,
    pub environment: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub files: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub ulimits: std::collections::BTreeMap<String, i64>,
}
/// CFS period for container CPU limits, matching kubelet and `docker --cpus`.
pub(crate) const CPU_PERIOD_MICROS: u64 = 100_000;
/// The supervisor every managed vLLM and Ollama image runs.
pub const RUNTIME_ENTRYPOINT: &str = "/usr/local/bin/nemoclaw-runtime";
/// Where a runtime keeps its data, such as downloaded models.
pub const RUNTIME_DATA_PATH: &str = "/data";
/// The environment variable that carries a runtime's contract.
pub const RUNTIME_SPEC_ENV: &str = "NEMOCLAW_RUNTIME_SPEC";
/// Process limits a runtime needs: unlimited locked memory for GPU transfers,
/// and a 64 MiB stack. `-1` means unlimited.
pub const RUNTIME_ULIMITS: [(&str, i64); 2] = [("memlock", -1), ("stack", 67_108_864)];
/// Shared memory a runtime gets unless its service sets its own.
pub fn default_shared_memory_bytes() -> u64 {
    crate::services::installers::vllm::ServiceContainer::resources(None).shared_memory_bytes
}
/// The kernel's minimum CFS quota; kubelet raises smaller CPU limits to it.
const MIN_CPU_QUOTA_MICROS: u64 = 1000;

/// CFS quota per [`CPU_PERIOD_MICROS`] for a CPU limit in millicores.
pub(crate) fn cpu_quota_micros(limit_millis: u32) -> u64 {
    (u64::from(limit_millis) * CPU_PERIOD_MICROS / 1000).max(MIN_CPU_QUOTA_MICROS)
}
/// Data source computing a Docker gateway container's launch.
pub const GATEWAY_RUNTIME_DATA_SOURCE: &str = "gateway_runtime";
/// Process launch of a gateway container.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayLaunch {
    pub entrypoint: Vec<String>,
    pub command: Vec<String>,
    pub env: Vec<String>,
}
fn gateway_launch(driver: ComputeDriver, name: &str, port: u16, data_path: &str) -> GatewayLaunch {
    // Docker publishes the port from the gateway network; Podman uses host networking.
    let bind_address = if driver == ComputeDriver::Docker {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    GatewayLaunch {
        entrypoint: vec!["/usr/local/bin/openshell-gateway".into()],
        command: vec![
            "--config".into(),
            format!("{data_path}/gateway.toml"),
            "--name".into(),
            name.into(),
            "--bind-address".into(),
            bind_address.into(),
            "--port".into(),
            port.to_string(),
        ],
        env: vec![
            format!("XDG_STATE_HOME={data_path}/state"),
            format!("OPENSHELL_DB_URL=sqlite:{data_path}/gateway.db"),
        ],
    }
}
/// Launch a Docker gateway container from its name, endpoint, and the data
/// path its storage returns.
///
/// # Errors
/// Returns a conflict naming the invalid setting.
pub fn docker_gateway_launch(
    name: &str,
    endpoint: &str,
    data_path: &str,
) -> Result<GatewayLaunch, Error> {
    check_gateway_attribute("name", name).map_err(|_| {
        Error::Conflict(
            "name must be nc-, 16 lowercase hexadecimal characters, a hyphen, and a lowercase name",
        )
    })?;
    let port = endpoint
        .strip_prefix("http://")
        .and_then(|authority| authority.strip_suffix('/').or(Some(authority)))
        .and_then(|authority| authority.parse::<std::net::SocketAddr>().ok())
        .filter(|address| address.ip().is_loopback() && address.port() >= 1024)
        .ok_or(Error::Conflict(
            "endpoint must be an HTTP origin with a loopback address and an unprivileged port",
        ))?
        .port();
    if !data_path.starts_with('/')
        || data_path.len() < 2
        || data_path.split('/').any(|segment| segment == "..")
        || data_path.contains(|c: char| c.is_control() || c.is_whitespace())
    {
        return Err(Error::Conflict(
            "data_path must be an absolute path without parent segments or whitespace",
        ));
    }
    Ok(gateway_launch(ComputeDriver::Docker, name, port, data_path))
}
/// Resource attributes of a managed gateway and its storage.
pub const GATEWAY_ATTRIBUTES: [&str; 8] = [
    "name",
    "owner",
    "generation",
    "compute_driver",
    "engine",
    "endpoint",
    "image",
    "network_cidr",
];
/// Authored OpenShell gateway settings, as JSON, when the deployment sets
/// them; absent otherwise.
pub const CONFIG_ATTRIBUTE: &str = "gateway_config";
/// Docker gateway data does not depend on the listen port, so its storage
/// records this endpoint instead of the gateway's.
const DOCKER_STORAGE_ENDPOINT: &str = "http://127.0.0.1:8080";

/// Check one gateway attribute, explaining a rejected value without echoing it.
pub fn check_gateway_attribute(attribute: &str, value: &str) -> Result<(), &'static str> {
    let (pattern, requirement) = match attribute {
        "name" => (
            r"^nc-[a-f0-9]{16}-[a-z][a-z0-9-]{0,72}$",
            "must be nc-, 16 lowercase hexadecimal characters, a hyphen, and a lowercase name",
        ),
        "owner" => (r"^[a-f0-9-]{36}$", "must be a lowercase UUID"),
        "generation" => (
            r"^[a-f0-9]{32}$",
            "must be 32 lowercase hexadecimal characters",
        ),
        "compute_driver" => (r"^(docker|podman)$", "must be docker or podman"),
        "engine" => {
            return crate::config::validate_engine_endpoint(value)
                .map_err(|_| "must be a local Unix engine socket");
        }
        CONFIG_ATTRIBUTE => {
            return match serde_json::from_str::<super::gateway_config::GatewayConfig>(value) {
                Ok(config)
                    if super::gateway_config::render(toml::Table::new(), &config).is_ok() =>
                {
                    Ok(())
                }
                _ => Err("must be a JSON object in the OpenShell chart's gatewayConfig format"),
            };
        }
        _ => return Ok(()),
    };
    if crate::config::constraints::matches(pattern, value) {
        Ok(())
    } else {
        Err(requirement)
    }
}
impl Spec {
    /// Runtime specification compiled into resource values: typed attributes
    /// for gateways and their storage, encoded JSON for service processes.
    pub(crate) fn from_values(kind: &str, values: &crate::backend::Row) -> Result<Self, Error> {
        if matches!(kind, GATEWAY_KIND | GATEWAY_STORAGE_KIND) {
            return Self::from_gateway_row(kind, values);
        }
        let spec: Self = serde_json::from_str(
            values
                .get("spec")
                .ok_or(Error::State("missing runtime spec"))?,
        )
        .map_err(|_| Error::State("invalid runtime specification"))?;
        spec.validate()?;
        Ok(spec)
    }
    /// Replace the specification compiled into resource values.
    pub(crate) fn write_values(
        &self,
        kind: &str,
        values: &mut crate::backend::Row,
    ) -> Result<(), Error> {
        if matches!(kind, GATEWAY_KIND | GATEWAY_STORAGE_KIND) {
            values.remove("endpoint");
            values.extend(self.gateway_row(kind)?);
        } else {
            values.insert("spec".into(), self.json()?);
        }
        Ok(())
    }
    /// The storage specification of this gateway.
    pub fn storage(&self) -> Self {
        let mut storage = self.clone();
        if self.compute_driver == ComputeDriver::Docker {
            storage.layout = 1;
            storage.gateway.endpoint = DOCKER_STORAGE_ENDPOINT.into();
        } else {
            storage.layout = 0;
        }
        storage
    }
    /// Resource attributes of this gateway or its storage.
    ///
    /// # Errors
    /// Returns an error if the specification is invalid.
    pub fn gateway_row(&self, kind: &str) -> Result<crate::backend::Row, Error> {
        self.validate()?;
        let docker_storage = kind == GATEWAY_STORAGE_KIND && self.layout == 1;
        let mut row: crate::backend::Row = GATEWAY_ATTRIBUTES
            .into_iter()
            .zip([
                self.name.as_str(),
                &self.owner,
                &self.generation,
                self.compute_driver.as_str(),
                &self.gateway.engine,
                &self.gateway.endpoint,
                &self.image,
                &self.gateway.network_cidr,
            ])
            .filter(|(attribute, _)| !(docker_storage && *attribute == "endpoint"))
            .map(|(attribute, value)| (attribute.to_owned(), value.to_owned()))
            .collect();
        // Storage holds no configuration: the gateway container receives it.
        if let Some(config) = self
            .gateway
            .config
            .as_ref()
            .filter(|_| kind == GATEWAY_KIND)
        {
            row.insert(
                CONFIG_ATTRIBUTE.into(),
                serde_json::to_string(config)
                    .map_err(|_| Error::State("cannot encode gateway config"))?,
            );
        }
        Ok(row)
    }
    /// Gateway or storage specification named by resource attributes.
    ///
    /// # Errors
    /// Returns an incomplete observation for missing attributes and a conflict
    /// for invalid ones, including an endpoint on Docker gateway storage.
    pub fn from_gateway_row(kind: &str, row: &crate::backend::Row) -> Result<Self, Error> {
        let get = |attribute: &str| {
            row.get(attribute)
                .filter(|value| !value.is_empty())
                .cloned()
                .ok_or(crate::ObservationError::Incomplete)
        };
        for attribute in GATEWAY_ATTRIBUTES.into_iter().chain([CONFIG_ATTRIBUTE]) {
            if let Some(value) = row
                .get(attribute)
                .filter(|value| !value.is_empty() || attribute != CONFIG_ATTRIBUTE)
            {
                check_gateway_attribute(attribute, value)
                    .map_err(|_| Error::Conflict("invalid managed gateway attribute"))?;
            }
        }
        let compute_driver = match get("compute_driver")?.as_str() {
            "podman" => ComputeDriver::Podman,
            _ => ComputeDriver::Docker,
        };
        let (layout, endpoint) = match (kind, compute_driver) {
            (GATEWAY_KIND, _) => (2, get("endpoint")?),
            (GATEWAY_STORAGE_KIND, ComputeDriver::Docker) => {
                if row.get("endpoint").is_some_and(|value| !value.is_empty()) {
                    return Err(Error::Conflict(
                        "Docker gateway storage does not take an endpoint",
                    ));
                }
                (1, DOCKER_STORAGE_ENDPOINT.into())
            }
            (GATEWAY_STORAGE_KIND, _) => (0, get("endpoint")?),
            _ => return Err(crate::ObservationError::BindingMismatch.into()),
        };
        let spec = Self {
            layout,
            compute_driver,
            kind: GATEWAY_KIND.into(),
            name: get("name")?,
            owner: get("owner")?,
            generation: get("generation")?,
            gateway: ManagedGateway {
                runtime: crate::config::Runtime {
                    provider: compute_driver,
                },
                endpoint,
                engine: get("engine")?,
                image_pull_policy: None,
                network_cidr: get("network_cidr")?,
                kubernetes: None,
                config: match row.get(CONFIG_ATTRIBUTE).filter(|value| !value.is_empty()) {
                    Some(value) => Some(
                        serde_json::from_str(value)
                            .map_err(|_| Error::Conflict("invalid managed gateway attribute"))?,
                    ),
                    None => None,
                },
            },
            image: get("image")?,
            process: None,
        };
        spec.validate()?;
        Ok(spec)
    }
}
fn is_docker_driver(value: &ComputeDriver) -> bool {
    *value == ComputeDriver::Docker
}
fn is_zero(value: &u32) -> bool {
    *value == 0
}
fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
impl Process {
    fn valid_launch(&self) -> bool {
        if let Some(image) = &self.image_owned {
            !image.user.is_empty()
                && self.configuration.is_empty()
                && self.entrypoint.is_empty()
                && self.command.is_empty()
        } else {
            !self.configuration.is_empty()
                && !self.configuration.contains(['\0', '\r', '\n'])
                && self.configuration.len() <= 1 << 20
                && !self.entrypoint.is_empty()
                && !self.bind_address.is_empty()
                && self.port != 0
                && !self.architecture.is_empty()
        }
    }
}
impl Spec {
    /// Validate ownership, configuration, runtime kind, and layout.
    ///
    /// # Errors
    /// Returns an error if any of these contracts is invalid.
    pub fn validate(&self) -> Result<(), Error> {
        let matches = crate::config::constraints::matches;
        if !matches(r"^nc-[a-f0-9]{16}-[a-z][a-z0-9-]{0,72}$", &self.name)
            || !matches(r"^[a-f0-9-]{36}$", &self.owner)
            || !matches(r"^[a-f0-9]{32}$", &self.generation)
        {
            return Err(Error::Conflict(
                "managed resource lacks ownership or generation",
            ));
        }
        if self.gateway.kubernetes.is_some()
            || !matches!(
                self.compute_driver,
                ComputeDriver::Docker | ComputeDriver::Podman
            )
            || (self.process.is_some() && self.compute_driver != ComputeDriver::Docker)
        {
            return Err(Error::Conflict("unsupported managed compute driver"));
        }
        if self
            .process
            .as_ref()
            .is_none_or(|process| !process.create_network)
        {
            self.gateway.validate_managed()?;
        }
        if self.kind == GATEWAY_KIND && self.process.is_none() && matches!(self.layout, 0..=2) {
            // The gateway runs the SDK's pinned image; nothing authors it.
            if self.image != crate::config::DEFAULT_GATEWAY_IMAGE {
                return Err(Error::Conflict(
                    "the managed gateway image must be this SDK's pinned image",
                ));
            }
            return Ok(());
        }
        if !self.image.is_empty() {
            return Err(Error::Conflict(
                "a managed service carries its image in its process",
            ));
        }
        if self.kind != GATEWAY_KIND
            && self.layout == 0
            && let Some(process) = &self.process
        {
            let valid_token = |value: &str| {
                !value.is_empty() && !value.contains(['\0', '\r', '\n']) && value.len() <= 1 << 20
            };
            if self
                .kind
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                && crate::config::validate_engine_endpoint(&process.engine).is_ok()
                && (process.engine.starts_with("unix://") || process.engine.starts_with("ssh://"))
                && process.image.contains("@sha256:")
                && process.valid_launch()
                && process.entrypoint.iter().all(|value| valid_token(value))
                && process.command.iter().all(|value| valid_token(value))
                && process.mount_target.starts_with('/')
                && !process.mount_target.contains("..")
                && process.memory_bytes > 0
                && process.cpu_limit_millis != Some(0)
            {
                return Ok(());
            }
            return Err(Error::Conflict("invalid managed service process"));
        }
        Err(Error::Conflict("invalid managed runtime kind or layout"))
    }
    pub fn validate_runtime(&self) -> Result<(), Error> {
        self.validate()?;
        if self.kind == GATEWAY_KIND && self.layout != 2 {
            return Err(Error::Conflict(
                "unsupported managed gateway process layout; resources retained",
            ));
        }
        Ok(())
    }
    pub fn binding_namespace(
        &self,
        engine_id: Option<&str>,
        network_id: Option<&str>,
    ) -> Result<String, Error> {
        if self.compute_driver == ComputeDriver::Podman {
            let network = network_id
                .filter(|id| id.len() == 64 && id.bytes().all(|c| c.is_ascii_hexdigit()))
                .ok_or(crate::ObservationError::Incomplete)?;
            // Podman 4.x generates a new compatibility /info.ID on each call.
            // Its retained, owned network UUID anchors this gateway's namespace.
            Ok(format!("podman-{network}"))
        } else {
            engine_id
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .ok_or(crate::ObservationError::Incomplete.into())
        }
    }
    pub fn engine(&self) -> &str {
        self.process
            .as_ref()
            .map_or(&self.gateway.engine, |process| &process.engine)
    }
    pub fn network_cidr(&self) -> &str {
        self.process
            .as_ref()
            .map_or(&self.gateway.network_cidr, |process| &process.network_cidr)
    }
    /// Resolve the bridge for service placement or the gateway network.
    ///
    /// # Errors
    /// Returns a configuration error for malformed IPv4 CIDRs or address overflow.
    pub fn bridge(&self) -> Result<String, Error> {
        crate::config::bridge_address(self.network_cidr()).map_err(Into::into)
    }
    /// Resolve the gateway container address on the managed network.
    ///
    /// # Errors
    /// Returns a configuration error for malformed IPv4 CIDRs or address overflow.
    pub fn gateway_address(&self) -> Result<String, Error> {
        crate::config::gateway_address(self.network_cidr()).map_err(Into::into)
    }
    /// Validate and extract the service configuration used inside the runtime.
    ///
    /// # Errors
    /// Returns an error for invalid ownership, configuration, kind, or layout,
    /// or when no managed service process is present.
    pub fn runtime_configuration(&self) -> Result<&str, Error> {
        self.validate_runtime()?;
        self.process
            .as_ref()
            .filter(|process| process.image_owned.is_none())
            .map(|process| process.configuration.as_str())
            .ok_or(Error::Conflict(
                "runtime specification has no managed service process",
            ))
    }
    /// Serialize a validated runtime specification.
    ///
    /// # Errors
    /// Returns an error if validation or serialization fails.
    pub fn json(&self) -> Result<String, Error> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|_| Error::State("cannot serialize runtime specification"))
    }
    /// Compile ownership labels and the serialized specification.
    ///
    /// # Errors
    /// Returns validation or serialization errors from `json`.
    pub fn labels(&self) -> Result<HashMap<String, String>, Error> {
        self.validate()?;
        let identity = if self.process.is_some() {
            let mut identity = serde_json::to_value(self)
                .map_err(|_| Error::State("cannot serialize process identity"))?;
            identity.as_object_mut().unwrap().remove("gateway");
            serde_json::to_string(&identity)
                .map_err(|_| Error::State("cannot serialize process identity"))?
        } else {
            let mut identity = self.clone();
            identity.gateway.image_pull_policy = None;
            identity.json()?
        };

        Ok([
            (OWNER_LABEL.into(), self.owner.clone()),
            (GENERATION_LABEL.into(), self.generation.clone()),
            (SPEC_LABEL.into(), hex(Sha256::digest(identity))),
        ]
        .into())
    }
    pub fn volume(&self) -> String {
        format!("{}-data", self.name)
    }
    pub fn network(&self) -> String {
        format!(
            "nc-{}-network",
            hex(&Sha256::digest(self.owner.as_bytes())[..8])
        )
    }
    pub fn image(&self) -> &str {
        self.process
            .as_ref()
            .map(|process| process.image.as_str())
            .unwrap_or(&self.image)
    }
    /// Compile the container launch configuration for the runtime.
    ///
    /// # Errors
    /// Returns an error for invalid specifications, unsupported runtime layouts,
    /// missing endpoint or service data, or launch configuration serialization.
    pub fn container(&self, data_path: &str) -> Result<ContainerCreateBody, Error> {
        self.validate_runtime()?;
        let mut host = json!({"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"RestartPolicy":{"Name":"no","MaximumRetryCount":0},"LogConfig":{"Type":"json-file","Config":{"max-size":"32m","max-file":"3"}},"Memory":0,"MemorySwap":0,"ShmSize":0});
        let mut config = json!({"Image":self.image(),"User":"","Labels":self.labels()?});
        if self.kind == GATEWAY_KIND {
            let url = url::Url::parse(&self.gateway.endpoint)
                .map_err(|_| Error::Conflict("invalid gateway endpoint"))?;
            let port = url.port().ok_or(Error::Conflict("missing gateway port"))?;
            config["User"] = json!("0:0");
            let launch = gateway_launch(self.compute_driver, &self.name, port, data_path);
            config["Env"] = json!(launch.env);
            config["Entrypoint"] = json!(launch.entrypoint);
            config["Cmd"] = json!(launch.command);
            if self.compute_driver == ComputeDriver::Podman {
                host["NetworkMode"] = json!("host");
                config["Hostname"] = json!(self.name);
                config["Env"].as_array_mut().unwrap().extend([
                    json!("container=podman"),
                    json!("HOME=/root"),
                    json!(format!("XDG_DATA_HOME={data_path}/data")),
                    json!(format!("HOSTNAME={}", self.name)),
                ]);
                host["PidMode"] = json!("private");
                host["IpcMode"] = json!("private");
                host["Ulimits"] = json!([{"Name":"nofile","Soft":65536,"Hard":65536},{"Name":"nproc","Soft":8192,"Hard":8192}]);
            } else {
                host["NetworkMode"] = json!(self.network());
                host["PortBindings"] = json!({format!("{port}/tcp"):[
                    {
                        "HostIp":url.host_str().ok_or(Error::Conflict("missing gateway host"))?,
                        "HostPort":port.to_string()
                    }
                ]});
                config["ExposedPorts"] = json!({format!("{port}/tcp"): {}});
                config["NetworkingConfig"] = json!({"EndpointsConfig":{
                    self.network():{"IPAMConfig":{"IPv4Address":self.gateway_address()?}}
                }});
            }
            host["Mounts"] = json!([{"Type":"volume","Source":self.volume(),"Target":data_path},{"Type":"bind","Source":self.gateway.engine.strip_prefix("unix://").ok_or(Error::Conflict("managed gateway requires a Unix socket"))?,"Target":"/var/run/docker.sock"}]);
        } else {
            let process = self.process.as_ref().ok_or(Error::Conflict(
                "runtime specification has no managed service process",
            ))?;
            if let Some(image) = &process.image_owned {
                config["User"] = json!(image.user);
                if let Some(command) = &image.command {
                    config["Cmd"] = json!(command);
                }
                if !image.ulimits.is_empty() {
                    host["Ulimits"] = json!(
                        image
                            .ulimits
                            .iter()
                            .map(|(name, limit)| json!({"Name":name,"Soft":limit,"Hard":limit}))
                            .collect::<Vec<_>>()
                    );
                }
                config["Env"] = json!(
                    image
                        .environment
                        .iter()
                        .map(|(key, value)| format!("{key}={value}"))
                        .collect::<Vec<_>>()
                );
            } else {
                config["Entrypoint"] = json!(process.entrypoint);
                config["Cmd"] = json!(process.command);
                config["Env"] = json!([format!(
                    "{RUNTIME_SPEC_ENV}={}",
                    self.runtime_configuration()?
                )]);
            }
            host["NetworkMode"] = json!(self.network());
            host["Mounts"] =
                json!([{"Type":"volume","Source":self.volume(),"Target":process.mount_target}]);
            host["ShmSize"] = json!(process.shared_memory_bytes);
            if process.host_ipc {
                host["IpcMode"] = json!("host");
            }
            host["Memory"] = json!(process.memory_bytes);
            host["MemorySwap"] = json!(process.memory_bytes);
            if let Some(limit) = process.cpu_limit_millis {
                host["CpuPeriod"] = json!(CPU_PERIOD_MICROS);
                host["CpuQuota"] = json!(cpu_quota_micros(limit));
            }
            if process.gpu {
                host["DeviceRequests"] = match &process.gpu_device {
                    Some(device) => {
                        json!([{"Driver":"","DeviceIDs":[device],"Capabilities":[["gpu"]]}])
                    }
                    None => json!([{"Driver":"","Count":-1,"Capabilities":[["gpu"]]}]),
                };
            }
            if process.image_owned.is_none() {
                host["Ulimits"] = json!(
                    RUNTIME_ULIMITS
                        .iter()
                        .map(|(name, limit)| json!({"Name": name, "Soft": limit, "Hard": limit}))
                        .collect::<Vec<_>>()
                );
            }
            if process.port != 0 && !process.bind_address.is_empty() {
                host["PortBindings"] = json!({format!("{}/tcp",process.port):[{"HostIp":process.bind_address,"HostPort":process.port.to_string()}]});
            }
        }
        config["HostConfig"] = host;
        serde_json::from_value(config)
            .map_err(|_| Error::State("invalid compiled runtime launch specification"))
    }
    /// The gateway's OpenShell configuration file: the keys NemoClaw owns,
    /// with the deployment's authored tables merged in.
    ///
    /// # Errors
    /// Returns a conflict if the authored tables are malformed or replace an
    /// owned key; validation rejects both before a specification exists.
    pub fn gateway_config(&self, data_path: &str) -> Result<String, Error> {
        let network = match self.compute_driver {
            ComputeDriver::Docker => String::new(),
            _ => self.network(),
        };
        gateway_file(
            self.compute_driver,
            &self.name,
            &network,
            &self.gateway.endpoint,
            data_path,
            self.gateway.config.as_ref(),
        )
    }
}

/// A Docker gateway's configuration file from its name, the data path its
/// storage returns, and the authored tables as JSON, empty when none.
///
/// # Errors
/// Returns a conflict naming the invalid setting.
pub fn docker_gateway_config(name: &str, data_path: &str, config: &str) -> Result<String, Error> {
    let config = if config.is_empty() {
        None
    } else {
        let config: super::gateway_config::GatewayConfig = serde_json::from_str(config)
            .map_err(|_| Error::Conflict("config must be a JSON object of gateway tables"))?;
        super::gateway_config::check(&config, "docker").map_err(|_| {
            Error::Conflict("config must be valid gateway tables without keys NemoClaw manages")
        })?;
        Some(config)
    };
    gateway_file(
        ComputeDriver::Docker,
        name,
        "",
        "",
        data_path,
        config.as_ref(),
    )
}

/// The OpenShell configuration file of a managed Docker or Podman gateway:
/// the keys NemoClaw owns, with the authored tables merged in.
fn gateway_file(
    compute_driver: ComputeDriver,
    name: &str,
    network: &str,
    endpoint: &str,
    data_path: &str,
    config: Option<&super::gateway_config::GatewayConfig>,
) -> Result<String, Error> {
    use toml::{Table, Value};
    fn table<const N: usize>(entries: [(&str, Value); N]) -> Value {
        Value::Table(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
        )
    }
    let text = |value: &str| Value::String(value.to_owned());
    // Docker supervisors use host networking and derive the loopback callback
    // from the runtime listen port. Storage normalizes that port separately.
    // Scope startup cleanup by gateway instead of using the shared default.
    let mut driver = match compute_driver {
        ComputeDriver::Docker => table([("sandbox_label", text(name))]),
        _ => table([
            ("socket_path", text("/var/run/docker.sock")),
            ("network_name", text(network)),
            ("grpc_endpoint", text(endpoint)),
        ]),
    };
    if let Value::Table(driver) = &mut driver {
        driver.insert("sandbox_runtime_image".into(), text(SANDBOX_RUNTIME_IMAGE));
        driver.insert("supervisor_image".into(), text(SUPERVISOR_IMAGE));
    }
    let gateway = table([
        ("compute_driver", text(compute_driver.as_str())),
        ("disable_tls", Value::Boolean(true)),
        (
            "gateway_jwt",
            table([
                (
                    "signing_key_path",
                    text(&format!("{data_path}/tls/jwt/signing.pem")),
                ),
                (
                    "public_key_path",
                    text(&format!("{data_path}/tls/jwt/public.pem")),
                ),
                ("kid_path", text(&format!("{data_path}/tls/jwt/kid"))),
                ("gateway_id", text(name)),
            ]),
        ),
        (
            "auth",
            table([("allow_unauthenticated_users", Value::Boolean(true))]),
        ),
    ]);
    let mut drivers = Table::new();
    drivers.insert(compute_driver.as_str().into(), driver);
    let mut root = Table::new();
    root.insert(
        "openshell".into(),
        table([
            ("version", Value::Integer(2)),
            ("gateway", gateway),
            ("drivers", Value::Table(drivers)),
        ]),
    );
    let root = match config {
        Some(config) => super::gateway_config::render(root, config)
            .map_err(|_| Error::Conflict("invalid managed gateway configuration"))?,
        None => root,
    };
    toml::to_string(&root).map_err(|_| Error::State("cannot encode gateway configuration"))
}
