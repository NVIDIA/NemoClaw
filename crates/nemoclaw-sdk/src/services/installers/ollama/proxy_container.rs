// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::Error;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
pub struct ProxySpec {
    pub settings: ProxySettings,
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub image: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_pull_policy: Option<crate::config::ImagePullPolicy>,
    pub bind_address: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxySettings {
    pub upstream: String,
    pub endpoint: String,
    pub model: String,
    pub digest: String,
}
impl ProxySpec {
    pub fn volume(&self) -> String {
        format!("{}-auth", self.name)
    }
    pub fn validate(&self) -> Result<(), Error> {
        let bind = self
            .bind_address
            .parse::<SocketAddr>()
            .map_err(|_| Error::Conflict("invalid Ollama proxy binding"))?;
        if !regex::Regex::new(r"^nc-[a-f0-9]{16}-ollama-proxy-[a-z][a-z0-9-]*$")
            .unwrap()
            .is_match(&self.name)
            || self.owner.is_empty()
            || self.generation.is_empty()
            || !regex::Regex::new(crate::config::constraints::IMAGE)
                .unwrap()
                .is_match(&self.image)
            || bind.port() == 0
            || !(bind.ip().is_loopback()
                || match bind.ip() {
                    std::net::IpAddr::V4(ip) => ip.is_private(),
                    std::net::IpAddr::V6(ip) => ip.is_unique_local(),
                })
        {
            return Err(Error::Conflict(
                "Ollama proxy requires owned, pinned configuration and a private bind address",
            ));
        }
        {
            let proxy = &self.settings;
            let upstream = url::Url::parse(&proxy.upstream)
                .map_err(|_| Error::Conflict("invalid proxy upstream"))?;
            if proxy.endpoint != format!("http://{}/v1", self.bind_address)
                || upstream.scheme() != "http"
                || upstream.path() != "/v1"
                || upstream.port().is_none()
                || upstream.query().is_some()
                || upstream.fragment().is_some()
                || !upstream.username().is_empty()
                || upstream.password().is_some()
                || !match upstream.host() {
                    Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                    Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                    _ => false,
                }
                || !regex::Regex::new(super::MODEL_PATTERN)
                    .unwrap()
                    .is_match(&proxy.model)
                || !regex::Regex::new("^[a-f0-9]{64}$")
                    .unwrap()
                    .is_match(&proxy.digest)
            {
                return Err(Error::Conflict(
                    "invalid external Ollama proxy specification",
                ));
            }
        }
        Ok(())
    }
}
#[cfg(all(test, unix))]
#[path = "proxy_container_tests.rs"]
mod tests;
