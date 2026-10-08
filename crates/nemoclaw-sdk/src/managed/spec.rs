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
pub use nemoclaw_runtime::{
    SPEC_VERSION as RUNTIME_SPEC_VERSION, SPEC_VERSION_LABEL as RUNTIME_SPEC_VERSION_LABEL,
};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<Process>,
}

/// Package-neutral container process compiled by a service installer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
    pub mount_target: String,
    pub bind_address: String,
    pub port: u16,
    pub shared_memory_bytes: u64,
    pub host_ipc: bool,
    pub memory_bytes: u64,
    pub gpu: bool,
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
        _ => return Ok(()),
    };
    if regex::Regex::new(pattern).unwrap().is_match(value) {
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
        Ok(GATEWAY_ATTRIBUTES
            .into_iter()
            .zip([
                self.name.as_str(),
                &self.owner,
                &self.generation,
                self.compute_driver.as_str(),
                &self.gateway.engine,
                &self.gateway.endpoint,
                &self.gateway.image,
                &self.gateway.network_cidr,
            ])
            .filter(|(attribute, _)| !(docker_storage && *attribute == "endpoint"))
            .map(|(attribute, value)| (attribute.to_owned(), value.to_owned()))
            .collect())
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
        for attribute in GATEWAY_ATTRIBUTES {
            if let Some(value) = row.get(attribute) {
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
                image: get("image")?,
                image_pull_policy: None,
                network_cidr: get("network_cidr")?,
                kubernetes: None,
            },
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
impl Spec {
    /// Validate ownership, configuration, runtime kind, and layout.
    ///
    /// # Errors
    /// Returns an error if any of these contracts is invalid.
    pub fn validate(&self) -> Result<(), Error> {
        if !regex::Regex::new(r"^nc-[a-f0-9]{16}-[a-z][a-z0-9-]{0,72}$")
            .unwrap()
            .is_match(&self.name)
            || !regex::Regex::new(r"^[a-f0-9-]{36}$")
                .unwrap()
                .is_match(&self.owner)
            || !regex::Regex::new(r"^[a-f0-9]{32}$")
                .unwrap()
                .is_match(&self.generation)
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
            return Ok(());
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
                && valid_token(&process.configuration)
                && !process.entrypoint.is_empty()
                && process.entrypoint.iter().all(|value| valid_token(value))
                && process.command.iter().all(|value| valid_token(value))
                && process.mount_target.starts_with('/')
                && !process.mount_target.contains("..")
                && !process.bind_address.is_empty()
                && process.port != 0
                && !process.architecture.is_empty()
                && process.memory_bytes > 0
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
        let mut identity = self.clone();
        identity.gateway.image_pull_policy = None;

        Ok([
            (OWNER_LABEL.into(), self.owner.clone()),
            (GENERATION_LABEL.into(), self.generation.clone()),
            (SPEC_LABEL.into(), hex(Sha256::digest(identity.json()?))),
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
            .unwrap_or(&self.gateway.image)
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
            config["Env"] = json!([
                format!("XDG_STATE_HOME={data_path}/state"),
                format!("OPENSHELL_DB_URL=sqlite:{data_path}/gateway.db")
            ]);
            config["Entrypoint"] = json!(["/usr/local/bin/openshell-gateway"]);
            config["Cmd"] = json!([
                "--config",
                &format!("{data_path}/gateway.toml"),
                "--name",
                &self.name,
                "--bind-address",
                if self.compute_driver == ComputeDriver::Docker {
                    "0.0.0.0"
                } else {
                    "127.0.0.1"
                },
                "--port",
                &port.to_string()
            ]);
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
            config["Entrypoint"] = json!(process.entrypoint);
            config["Cmd"] = json!(process.command);
            config["Env"] = json!([format!(
                "NEMOCLAW_RUNTIME_SPEC={}",
                self.runtime_configuration()?
            )]);
            host["NetworkMode"] = json!(self.network());
            host["Mounts"] =
                json!([{"Type":"volume","Source":self.volume(),"Target":process.mount_target}]);
            host["ShmSize"] = json!(process.shared_memory_bytes);
            if process.host_ipc {
                host["IpcMode"] = json!("host");
            }
            host["Memory"] = json!(process.memory_bytes);
            host["MemorySwap"] = json!(process.memory_bytes);
            if process.gpu {
                host["DeviceRequests"] = json!([{"Driver":"","Count":-1,"Capabilities":[["gpu"]]}]);
            }
            host["Ulimits"] = json!([{"Name":"memlock","Soft":-1,"Hard":-1},{"Name":"stack","Soft":67108864,"Hard":67108864}]);
            host["PortBindings"] = json!({format!("{}/tcp",process.port):[{"HostIp":process.bind_address,"HostPort":process.port.to_string()}]});
        }
        config["HostConfig"] = host;
        serde_json::from_value(config)
            .map_err(|_| Error::State("invalid compiled runtime launch specification"))
    }
    pub fn gateway_config(&self, data_path: &str) -> String {
        let grpc_endpoint = if self.compute_driver == ComputeDriver::Docker {
            String::new()
        } else {
            format!("grpc_endpoint = {:?}\n", self.gateway.endpoint)
        };
        // Docker supervisors use host networking and derive the loopback callback
        // from the runtime listen port. Storage normalizes that port separately.
        // Scope startup cleanup by gateway instead of using the shared default.
        let namespace = if self.compute_driver == ComputeDriver::Docker {
            format!("sandbox_label = {:?}\n", self.name)
        } else {
            format!("network_name = {:?}\n", self.network())
        };
        format!(
            "[openshell]\nversion = 2\n\n[openshell.gateway]\ncompute_driver = {:?}\ndisable_tls = true\n\n[openshell.drivers.{}]{}\n{}sandbox_runtime_image = {:?}\nsupervisor_image = {:?}\n{}\n[openshell.gateway.gateway_jwt]\nsigning_key_path = {:?}\npublic_key_path = {:?}\nkid_path = {:?}\ngateway_id = {:?}\n\n[openshell.gateway.auth]\nallow_unauthenticated_users = true\n",
            self.compute_driver.as_str(),
            self.compute_driver,
            if self.compute_driver == ComputeDriver::Podman {
                "\nsocket_path = \"/var/run/docker.sock\""
            } else {
                ""
            },
            namespace,
            SANDBOX_RUNTIME_IMAGE,
            SUPERVISOR_IMAGE,
            grpc_endpoint,
            format!("{data_path}/tls/jwt/signing.pem"),
            format!("{data_path}/tls/jwt/public.pem"),
            format!("{data_path}/tls/jwt/kid"),
            self.name
        )
    }
}
