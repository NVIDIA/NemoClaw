// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(test)]
#[path = "spec_tests.rs"]
mod tests;

use crate::{Error, config::Gateway};
use bollard::models::ContainerCreateBody;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
pub const GATEWAY_KIND: &str = "managed_gateway";
pub const OWNER_LABEL: &str = "nemoclaw.nvidia.com/uid";
pub const GENERATION_LABEL: &str = "nemoclaw.nvidia.com/generation";
pub const SPEC_LABEL: &str = "nemoclaw.nvidia.com/runtime-spec";
pub use crate::artifact_pins::SANDBOX_RUNTIME_IMAGE;
pub use crate::artifact_pins::SUPERVISOR_IMAGE;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    #[serde(default, skip_serializing_if = "is_zero")]
    pub layout: u32,
    #[serde(default = "docker_driver", skip_serializing_if = "is_docker_driver")]
    pub compute_driver: String,
    pub kind: String,
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub gateway: Gateway,
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
fn docker_driver() -> String {
    "docker".into()
}
fn is_docker_driver(value: &str) -> bool {
    value == "docker"
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
        if !matches!(self.compute_driver.as_str(), "docker" | "podman")
            || self.process.is_some() && self.compute_driver != "docker"
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
                && crate::docker::Engine::validate_endpoint(&process.engine).is_ok()
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
    pub(crate) fn validate_runtime(&self) -> Result<(), Error> {
        self.validate()?;
        if self.kind == GATEWAY_KIND && self.layout != 2 {
            return Err(Error::Conflict(
                "unsupported managed gateway process layout; resources retained",
            ));
        }
        Ok(())
    }
    pub(crate) fn binding_namespace(
        &self,
        engine_id: Option<&str>,
        network_id: Option<&str>,
    ) -> Result<String, Error> {
        if self.compute_driver == "podman" {
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
                "127.0.0.1",
                "--port",
                &url.port()
                    .ok_or(Error::Conflict("missing gateway port"))?
                    .to_string()
            ]);
            host["NetworkMode"] = json!("host");
            if self.compute_driver == "podman" {
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
        let grpc_endpoint = if self.compute_driver == "docker" {
            String::new()
        } else {
            format!("grpc_endpoint = {:?}\n", self.gateway.endpoint)
        };
        format!(
            "[openshell]\nversion = 2\n\n[openshell.gateway]\ncompute_driver = {:?}\ndisable_tls = true\n\n[openshell.drivers.{}]{}\nnetwork_name = {:?}\nsandbox_runtime_image = {:?}\nsupervisor_image = {:?}\n{}\n[openshell.gateway.gateway_jwt]\nsigning_key_path = {:?}\npublic_key_path = {:?}\nkid_path = {:?}\ngateway_id = {:?}\n\n[openshell.gateway.auth]\nallow_unauthenticated_users = true\n",
            self.compute_driver,
            self.compute_driver,
            if self.compute_driver == "podman" {
                "\nsocket_path = \"/var/run/docker.sock\""
            } else {
                ""
            },
            self.network(),
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
