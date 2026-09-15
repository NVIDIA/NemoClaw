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
pub const SUPERVISOR_IMAGE: &str = "ghcr.io/nvidia/openshell/supervisor@sha256:c8c42aef16c200063e32cbf72e553e4ead027085427b555efafd95063ecead42";
pub const SUPERVISOR_SHA256: &str =
    "7052a87d2b46ef52ecc0f7c64b9bac008dd3010c467881b0648045334eb0ed1d";
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
    pub fn validate(&self) -> Result<(), Error> {
        if !regex::Regex::new(r"^nc-[a-f0-9]{16}-(gateway|inference)$")
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
    pub fn bridge(&self) -> String {
        if let Some(p) = self.service.as_ref().and_then(|s| s.placement.as_ref()) {
            let net: ipnet::Ipv4Net = p.network_cidr.parse().expect("validated network");
            return std::net::Ipv4Addr::from(u32::from(net.network()) + 1).to_string();
        }
        self.gateway.bridge()
    }
    pub fn runtime_service(&self) -> Result<Service, Error> {
        self.validate_runtime()?;
        let mut service = self.service.clone().ok_or(Error::Conflict(
            "runtime specification has no inference service",
        ))?;
        service.placement = None;
        service.publication = None;
        Ok(service)
    }
    pub fn json(&self) -> Result<String, Error> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|_| Error::State("cannot serialize runtime specification"))
    }
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
    pub fn container(&self, data_path: &str) -> Result<ContainerCreateBody, Error> {
        self.validate_runtime()?;
        let mut host = json!({"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"RestartPolicy":{"Name":"no","MaximumRetryCount":0},"LogConfig":{"Type":"json-file","Config":{"max-size":"32m","max-file":"3"}},"Memory":0,"MemorySwap":0,"ShmSize":0});
        let mut config = json!({"Image":self.image(),"User":"","Labels":self.labels()?});
        if self.kind == GATEWAY_KIND {
            let url = url::Url::parse(&self.gateway.endpoint)
                .map_err(|_| Error::Conflict("invalid gateway endpoint"))?;
            config["User"] = json!("0:0");
            config["Env"] = json!([format!("XDG_STATE_HOME={data_path}/state")]);
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
                    .to_string(),
                "--drivers",
                "docker",
                "--disable-tls",
                "--db-url",
                &format!("sqlite:{data_path}/gateway.db")
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
            host["ShmSize"] = json!(8 * GIB);
            host["Memory"] = json!(104 * GIB);
            host["MemorySwap"] = json!(104 * GIB);
            host["DeviceRequests"] = json!([{"Driver":"","Count":-1,"Capabilities":[["gpu"]]}]);
            host["Ulimits"] = json!([{"Name":"memlock","Soft":-1,"Hard":-1},{"Name":"stack","Soft":67108864,"Hard":67108864}]);
            host["PortBindings"] = json!({format!("{}/tcp",service.serving.port):[{"HostIp":service.publication.as_ref().map(|p|p.bind_address.clone()).unwrap_or_else(||self.bridge()),"HostPort":service.serving.port.to_string()}]});
        }
        config["HostConfig"] = host;
        serde_json::from_value(config)
            .map_err(|_| Error::State("invalid compiled runtime launch specification"))
    }
    pub fn gateway_config(&self, data_path: &str) -> String {
        format!(
            "[openshell.drivers.docker]\nnetwork_name = {:?}\nssh_socket_path = {:?}\nsupervisor_bin = {:?}\n\n[openshell.gateway.gateway_jwt]\nsigning_key_path = {:?}\npublic_key_path = {:?}\nkid_path = {:?}\ngateway_id = {:?}\nttl_secs = 0\n\n[openshell.gateway.auth]\nallow_unauthenticated_users = true\n",
            self.network(),
            format!("{data_path}/ssh"),
            format!("{data_path}/openshell-sandbox"),
            format!("{data_path}/tls/jwt/signing.pem"),
            format!("{data_path}/tls/jwt/public.pem"),
            format!("{data_path}/tls/jwt/kid"),
            self.name
        )
    }
}
