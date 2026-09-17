// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(test)]
#[path = "spec_tests.rs"]
mod tests;

use crate::{
    Error,
    config::{Gateway, Service},
    hardware::GIB,
};
use bollard::models::ContainerCreateBody;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
pub const GATEWAY_KIND: &str = "managed_gateway";
pub const SERVICE_KIND: &str = "inference_service";
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
    pub kind: String,
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub gateway: Gateway,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<Service>,
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
        if !regex::Regex::new(r"^nc-[a-f0-9]{16}-(gateway|inference(?:-[a-z][a-z0-9-]{0,62})?)$")
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
        if self.service.as_ref().is_none_or(|s| s.placement.is_none()) {
            self.gateway.validate_managed()?;
        }
        if self.kind == GATEWAY_KIND && self.service.is_none() && matches!(self.layout, 0 | 2) {
            return Ok(());
        }
        if self.kind == SERVICE_KIND
            && self.layout == 0
            && let Some(service) = &self.service
        {
            return service.validate().map_err(Into::into);
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
    pub(crate) fn validate_image_authentication(
        &self,
        image: &bollard::models::ImageInspect,
    ) -> Result<(), Error> {
        if self
            .service
            .as_ref()
            .is_some_and(|s| s.authentication.is_some())
            && image
                .config
                .as_ref()
                .and_then(|c| c.labels.as_ref())
                .and_then(|l| l.get("org.nemoclaw.inference.authentication"))
                .map(String::as_str)
                != Some("bearer-v1")
        {
            return Err(Error::Conflict(
                "runtime image lacks managed bearer authentication; rebuild the runtime image",
            ));
        }
        Ok(())
    }
    pub fn engine(&self) -> &str {
        self.service
            .as_ref()
            .and_then(|s| s.placement.as_ref())
            .map_or(&self.gateway.engine, |p| &p.engine)
    }
    pub fn network_cidr(&self) -> &str {
        self.service
            .as_ref()
            .and_then(|s| s.placement.as_ref())
            .map_or(&self.gateway.network_cidr, |p| &p.network_cidr)
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
    /// or when no inference service is present.
    pub fn runtime_service(&self) -> Result<Service, Error> {
        self.validate_runtime()?;
        let mut service = self.service.clone().ok_or(Error::Conflict(
            "runtime specification has no inference service",
        ))?;
        service.placement = None;
        service.publication = None;
        Ok(service)
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
        Ok([
            (OWNER_LABEL.into(), self.owner.clone()),
            (GENERATION_LABEL.into(), self.generation.clone()),
            (SPEC_LABEL.into(), hex(Sha256::digest(self.json()?))),
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
        self.service
            .as_ref()
            .map(|service| service.image.as_str())
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
            host["Mounts"] = json!([{"Type":"volume","Source":self.volume(),"Target":data_path},{"Type":"bind","Source":"/var/run/docker.sock","Target":"/var/run/docker.sock"}]);
        } else {
            let service = self.service.as_ref().ok_or(Error::Conflict(
                "runtime specification has no inference service",
            ))?;
            config["Entrypoint"] = json!(["/usr/local/bin/nemoclaw-runtime"]);
            config["Cmd"] = json!([]);
            config["Env"] = json!([format!(
                "NEMOCLAW_RUNTIME_SPEC={}",
                serde_json::to_string(&self.runtime_service()?)
                    .map_err(|_| Error::State("cannot serialize runtime service"))?
            )]);
            host["NetworkMode"] = json!(self.network());
            host["Mounts"] = json!([{"Type":"volume","Source":self.volume(),"Target":"/data"}]);
            host["ShmSize"] = json!(
                service
                    .container
                    .as_ref()
                    .map_or(8, |c| c.shared_memory_gi_b)
                    * GIB
            );
            if service
                .container
                .as_ref()
                .is_some_and(|c| c.ipc == crate::config::ServiceIpc::Host)
            {
                host["IpcMode"] = json!("host");
            }
            host["Memory"] = json!(104 * GIB);
            host["MemorySwap"] = json!(104 * GIB);
            host["DeviceRequests"] = json!([{"Driver":"","Count":-1,"Capabilities":[["gpu"]]}]);
            host["Ulimits"] = json!([{"Name":"memlock","Soft":-1,"Hard":-1},{"Name":"stack","Soft":67108864,"Hard":67108864}]);
            let bind_address = match &service.publication {
                Some(publication) => publication.bind_address.clone(),
                None => self.bridge()?,
            };
            host["PortBindings"] = json!({format!("{}/tcp",service.serving.port):[{"HostIp":bind_address,"HostPort":service.serving.port.to_string()}]});
        }
        config["HostConfig"] = host;
        serde_json::from_value(config)
            .map_err(|_| Error::State("invalid compiled runtime launch specification"))
    }
    pub fn gateway_config(&self, data_path: &str) -> String {
        format!(
            "[openshell]\nversion = 2\n\n[openshell.gateway]\ncompute_driver = \"docker\"\ndisable_tls = true\n\n[openshell.drivers.docker]\nnetwork_name = {:?}\nsandbox_runtime_image = {:?}\nsupervisor_image = {:?}\n\n[openshell.gateway.gateway_jwt]\nsigning_key_path = {:?}\npublic_key_path = {:?}\nkid_path = {:?}\ngateway_id = {:?}\n\n[openshell.gateway.auth]\nallow_unauthenticated_users = true\n",
            self.network(),
            SANDBOX_RUNTIME_IMAGE,
            SUPERVISOR_IMAGE,
            format!("{data_path}/tls/jwt/signing.pem"),
            format!("{data_path}/tls/jwt/public.pem"),
            format!("{data_path}/tls/jwt/kid"),
            self.name
        )
    }
}
