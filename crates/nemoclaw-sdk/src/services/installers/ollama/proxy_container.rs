// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error, ObservationError,
    docker::{Engine, remote},
    managed::{GENERATION_LABEL, OWNER_LABEL},
};
use bollard::{
    models::{ContainerCreateBody, ContainerInspectResponse, Volume, VolumeCreateRequest},
    query_parameters::{CreateContainerOptions, RemoveContainerOptions},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, net::SocketAddr, time::Duration};
const SPEC_LABEL: &str = "nemoclaw.nvidia.com/ollama-spec";
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
#[derive(Clone, Debug)]
pub struct ProxyObservation {
    pub id: String,
    pub running: bool,
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
    fn labels(&self) -> Result<HashMap<String, String>, Error> {
        let mut identity = self.clone();
        identity.image_pull_policy = None;
        let bytes = serde_json::to_vec(&identity)
            .map_err(|_| Error::State("cannot encode Ollama proxy specification"))?;
        let digest = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Ok([
            (OWNER_LABEL.into(), self.owner.clone()),
            (GENERATION_LABEL.into(), self.generation.clone()),
            (SPEC_LABEL.into(), digest),
        ]
        .into())
    }
    pub(crate) fn container(&self) -> Result<ContainerCreateBody, Error> {
        let proxy = &self.settings;
        serde_json::from_value(json!({"Image":self.image,"Labels":self.labels()?,"Entrypoint":["python3","/opt/nemoclaw/ollama_proxy.py"],"Cmd":[],
            "Env":[format!("NEMOCLAW_OLLAMA_PROXY={}",serde_json::to_string(proxy).expect("typed proxy"))],
            "HostConfig":{"NetworkMode":"host","Mounts":[{"Type":"volume","Source":self.volume(),"Target":"/data"}],
                "CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"RestartPolicy":{"Name":"no"},"Memory":268435456,"MemorySwap":268435456}}))
            .map_err(|_|Error::State("invalid proxy container"))
    }

    fn storage_labels(&self) -> HashMap<String, String> {
        [
            (OWNER_LABEL.into(), self.owner.clone()),
            (GENERATION_LABEL.into(), self.generation.clone()),
        ]
        .into()
    }
    fn verify_volume(&self, volume: &Volume) -> Result<(), Error> {
        if volume.name != self.volume()
            || volume.driver != "local"
            || !volume.options.is_empty()
            || volume.created_at.as_ref().is_none_or(String::is_empty)
        {
            return Err(Error::Conflict(
                "Ollama proxy persistent volume configuration is incomplete or changed",
            ));
        }
        for (key, value) in self.storage_labels() {
            if volume.labels.get(&key) != Some(&value) {
                return Err(ObservationError::BindingMismatch.into());
            }
        }
        Ok(())
    }
    fn verify(&self, container: &ContainerInspectResponse, volume: &Volume) -> Result<bool, Error> {
        self.verify_volume(volume)?;
        let config = container
            .config
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        let host = container
            .host_config
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        let running = container
            .state
            .as_ref()
            .and_then(|s| s.running)
            .ok_or(ObservationError::Incomplete)?;
        let labels = config.labels.as_ref().ok_or(ObservationError::Incomplete)?;
        for (key, value) in self.labels()? {
            if labels.get(&key) != Some(&value) {
                return Err(ObservationError::BindingMismatch.into());
            }
        }
        let launch = self.container()?;
        let expected = launch.host_config.unwrap();
        if container.id.as_ref().is_none_or(String::is_empty)
            || container.name.as_deref().map(|n| n.trim_start_matches('/')) != Some(&self.name)
            || config.image.as_deref() != Some(&self.image)
            || config.entrypoint != launch.entrypoint
            || config.cmd != launch.cmd
            || host.network_mode != expected.network_mode
            || host.privileged.unwrap_or(false)
            || !host
                .cap_drop
                .as_ref()
                .is_some_and(|values| values.iter().any(|v| v == "ALL"))
            || !host
                .security_opt
                .as_ref()
                .is_some_and(|values| values.iter().any(|v| v == "no-new-privileges"))
            || host.port_bindings.as_ref().filter(|m| !m.is_empty())
                != expected.port_bindings.as_ref().filter(|m| !m.is_empty())
        {
            return Err(Error::Conflict(
                "Ollama proxy container configuration drift requires inspection",
            ));
        }
        {
            let expected_env = launch.env.unwrap_or_default();
            let observed_env: Vec<_> = config
                .env
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|s| s.starts_with("NEMOCLAW_"))
                .cloned()
                .collect();
            if observed_env != expected_env
                || host.memory != expected.memory
                || host.memory_swap != expected.memory_swap
                || host
                    .restart_policy
                    .as_ref()
                    .and_then(|p| p.name)
                    .is_some_and(|n| n.to_string() != "no")
            {
                return Err(Error::Conflict(
                    "proxy environment or process limits drifted",
                ));
            }
        }
        let mounts = container
            .mounts
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        if mounts.len() != 1
            || mounts[0].name.as_deref() != Some(&self.volume())
            || mounts[0].destination.as_deref() != Some("/data")
            || mounts[0].rw != Some(true)
            || mounts[0].typ.as_deref() != Some("volume")
        {
            return Err(Error::Conflict(
                "Ollama proxy persistent storage binding drifted",
            ));
        }
        Ok(running)
    }
}
impl Engine {
    /// Observe storage independently of whether its service is running or present.
    pub async fn observe_ollama_proxy_storage(
        &self,
        spec: &ProxySpec,
        id: &str,
    ) -> Result<Option<String>, Error> {
        spec.validate()?;
        let info = self.info().await?;
        let Some(volume) = self.volume(&spec.volume()).await? else {
            if !id.is_empty() {
                return Err(Error::Conflict(
                    "bound Ollama proxy storage is absent; recreation forbidden",
                ));
            }
            return Ok(None);
        };
        spec.verify_volume(&volume)?;
        let physical = format!(
            "{}/{}/{}",
            info.id.unwrap(),
            spec.volume(),
            volume.created_at.unwrap()
        );
        if !id.is_empty() && id != physical {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(Some(physical))
    }
    pub async fn ensure_ollama_proxy_storage(
        &self,
        spec: &ProxySpec,
        id: &str,
    ) -> Result<String, Error> {
        if let Some(id) = self.observe_ollama_proxy_storage(spec, id).await? {
            return Ok(id);
        }
        self.api
            .create_volume(VolumeCreateRequest {
                name: Some(spec.volume()),
                driver: Some("local".into()),
                labels: Some(spec.storage_labels()),
                ..Default::default()
            })
            .await
            .map_err(|error| remote(&error))?;
        self.observe_ollama_proxy_storage(spec, id)
            .await?
            .ok_or(ObservationError::Incomplete.into())
    }
    pub async fn observe_ollama_proxy_removal(
        &self,
        spec: &ProxySpec,
        id: &str,
    ) -> Result<Option<ProxyObservation>, Error> {
        let parts: Vec<_> = id.split('/').collect();
        if parts.len() != 3 || parts.iter().any(|p| p.is_empty()) {
            return Err(ObservationError::Incomplete.into());
        }
        self.observe_ollama_proxy_storage(
            spec,
            &format!("{}/{}/{}", parts[0], spec.volume(), parts[2]),
        )
        .await?;
        if self.container(&spec.name).await?.is_none() {
            return Ok(None);
        }
        self.observe_ollama_proxy(spec, id).await
    }
    pub async fn remove_ollama_proxy(&self, spec: &ProxySpec, id: &str) -> Result<(), Error> {
        if let Some(service) = self.observe_ollama_proxy_removal(spec, id).await? {
            let container = service
                .id
                .split('/')
                .nth(1)
                .ok_or(ObservationError::Incomplete)?;
            self.api
                .remove_container(
                    container,
                    Some(RemoveContainerOptions {
                        force: true,
                        v: false,
                        ..Default::default()
                    }),
                )
                .await
                .map_err(|error| remote(&error))?;
        }
        Ok(())
    }
    pub async fn observe_ollama_proxy(
        &self,
        spec: &ProxySpec,
        id: &str,
    ) -> Result<Option<ProxyObservation>, Error> {
        spec.validate()?;
        let work = async {
            let info = self.info().await?;
            let container = self.container(&spec.name).await?;
            let volume = self.volume(&spec.volume()).await?;
            let Some(container) = container else {
                if let Some(volume) = volume {
                    spec.verify_volume(&volume)?;
                    return Err(Error::PartialRuntime);
                }
                if !id.is_empty() {
                    return Err(Error::Conflict(
                        "bound Ollama proxy is absent; automatic recreation is forbidden",
                    ));
                }
                return Ok(None);
            };
            let volume = volume.ok_or(Error::Conflict(
                "Ollama proxy storage observation failed; absence is unconfirmed",
            ))?;
            let running = spec.verify(&container, &volume)?;
            let physical = format!(
                "{}/{}/{}",
                info.id.unwrap(),
                container.id.unwrap(),
                volume.created_at.unwrap()
            );
            if !id.is_empty() && id != physical {
                return Err(ObservationError::BindingMismatch.into());
            }
            Ok(Some(ProxyObservation {
                id: physical,
                running,
            }))
        };
        tokio::time::timeout(Duration::from_secs(20), work)
            .await
            .map_err(|_| ObservationError::Transport)?
    }
    pub async fn ensure_ollama_proxy(
        &self,
        spec: &ProxySpec,
        id: &str,
    ) -> Result<ProxyObservation, Error> {
        let observed = match self.observe_ollama_proxy(spec, id).await {
            Err(Error::PartialRuntime) if id.is_empty() => None,
            other => other?,
        };
        if observed.as_ref().is_some_and(|service| !service.running) {
            self.acquire_image(&spec.image, spec.image_pull_policy.unwrap_or_default())
                .await?;
        }
        if observed.is_none() {
            if !id.is_empty() {
                return Err(Error::Conflict(
                    "bound Ollama proxy unavailable; recreation forbidden",
                ));
            }
            self.acquire_image(&spec.image, spec.image_pull_policy.unwrap_or_default())
                .await?;
            if self.volume(&spec.volume()).await?.is_none() {
                self.api
                    .create_volume(VolumeCreateRequest {
                        name: Some(spec.volume()),
                        driver: Some("local".into()),
                        labels: Some(spec.storage_labels()),
                        ..Default::default()
                    })
                    .await
                    .map_err(|error| remote(&error))?;
            }
            let volume = self
                .volume(&spec.volume())
                .await?
                .ok_or(ObservationError::Incomplete)?;
            spec.verify_volume(&volume)?;
            if self.container(&spec.name).await?.is_some() {
                return Err(Error::Conflict(
                    "Ollama proxy appeared during create; reapply to reconcile",
                ));
            }
            self.api
                .create_container(
                    Some(CreateContainerOptions {
                        name: Some(spec.name.clone()),
                        ..Default::default()
                    }),
                    spec.container()?,
                )
                .await
                .map_err(|error| remote(&error))?;
        }
        let observed = self
            .observe_ollama_proxy(spec, id)
            .await?
            .ok_or(ObservationError::Incomplete)?;
        if !observed.running {
            let container = observed
                .id
                .split('/')
                .nth(1)
                .ok_or(ObservationError::Incomplete)?;
            self.api
                .start_container(container, None)
                .await
                .map_err(|error| remote(&error))?;
        }
        self.observe_ollama_proxy(spec, &observed.id)
            .await?
            .ok_or(ObservationError::Incomplete.into())
    }
}
#[cfg(all(test, unix))]
#[path = "proxy_container_tests.rs"]
mod tests;
