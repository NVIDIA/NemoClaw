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
pub struct ServiceSpec {
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub image: String,
    pub network: String,
    pub bind_address: String,
}
#[derive(Clone, Debug)]
pub struct Service {
    pub spec: ServiceSpec,
    pub id: String,
    pub running: bool,
}
impl ServiceSpec {
    pub fn volume(&self) -> String {
        format!("{}-models", self.name)
    }
    pub fn validate(&self) -> Result<(), Error> {
        let bind = self
            .bind_address
            .parse::<SocketAddr>()
            .map_err(|_| Error::Conflict("invalid Ollama binding"))?;
        if !regex::Regex::new(r"^nc-[a-f0-9]{16}-ollama$")
            .unwrap()
            .is_match(&self.name)
            || self.owner.is_empty()
            || self.generation.is_empty()
            || !regex::Regex::new(r"^ollama/ollama@sha256:[a-f0-9]{64}$")
                .unwrap()
                .is_match(&self.image)
            || !regex::Regex::new(r"^[a-z0-9][a-z0-9_-]*$")
                .unwrap()
                .is_match(&self.network)
            || bind.port() == 0
            || !(bind.ip().is_loopback()
                || match bind.ip() {
                    std::net::IpAddr::V4(ip) => ip.is_private(),
                    std::net::IpAddr::V6(ip) => ip.is_unique_local(),
                })
        {
            return Err(Error::Conflict(
                "Ollama requires owned, pinned configuration and a private bind address",
            ));
        }
        Ok(())
    }
    fn labels(&self) -> Result<HashMap<String, String>, Error> {
        let bytes = serde_json::to_vec(self)
            .map_err(|_| Error::State("cannot encode Ollama specification"))?;
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
    fn container(&self) -> Result<ContainerCreateBody, Error> {
        let bind = self
            .bind_address
            .parse::<SocketAddr>()
            .map_err(|_| Error::Conflict("invalid Ollama binding"))?;
        serde_json::from_value(json!({"Image":self.image,"Labels":self.labels()?,"Entrypoint":["/bin/ollama"],"Cmd":["serve"],"HostConfig":{"NetworkMode":self.network,"Mounts":[{"Type":"volume","Source":self.volume(),"Target":"/root/.ollama"}],"PortBindings":{"11434/tcp":[{"HostIp":bind.ip().to_string(),"HostPort":bind.port().to_string()}]},"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"]}})).map_err(|_|Error::State("invalid compiled Ollama container"))
    }
    fn verify_volume(&self, volume: &Volume) -> Result<(), Error> {
        if volume.name != self.volume()
            || volume.driver != "local"
            || !volume.options.is_empty()
            || volume.created_at.as_ref().is_none_or(String::is_empty)
        {
            return Err(Error::Conflict(
                "Ollama persistent volume configuration is incomplete or changed",
            ));
        }
        for (key, value) in self.labels()? {
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
            || host.port_bindings != expected.port_bindings
        {
            return Err(Error::Conflict(
                "Ollama container configuration drift requires inspection",
            ));
        }
        let mounts = container
            .mounts
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        if mounts.len() != 1
            || mounts[0].name.as_deref() != Some(&self.volume())
            || mounts[0].destination.as_deref() != Some("/root/.ollama")
            || mounts[0].rw != Some(true)
            || mounts[0].typ.as_deref() != Some("volume")
        {
            return Err(Error::Conflict("Ollama persistent storage binding drifted"));
        }
        Ok(running)
    }
}
impl Engine {
    /// Observe storage independently of whether its service is running or present.
    pub async fn observe_ollama_storage(
        &self,
        spec: &ServiceSpec,
        id: &str,
    ) -> Result<Option<String>, Error> {
        spec.validate()?;
        let info = self.info().await?;
        let Some(volume) = self.volume(&spec.volume()).await? else {
            if !id.is_empty() {
                return Err(Error::Conflict(
                    "bound Ollama storage is absent; recreation forbidden",
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
    pub async fn ensure_ollama_storage(
        &self,
        spec: &ServiceSpec,
        id: &str,
    ) -> Result<String, Error> {
        if let Some(id) = self.observe_ollama_storage(spec, id).await? {
            return Ok(id);
        }
        self.api
            .create_volume(VolumeCreateRequest {
                name: Some(spec.volume()),
                driver: Some("local".into()),
                labels: Some(spec.labels()?),
                ..Default::default()
            })
            .await
            .map_err(|error| remote(&error))?;
        self.observe_ollama_storage(spec, id)
            .await?
            .ok_or(ObservationError::Incomplete.into())
    }
    pub async fn observe_ollama_removal(
        &self,
        spec: &ServiceSpec,
        id: &str,
    ) -> Result<Option<Service>, Error> {
        let parts: Vec<_> = id.split('/').collect();
        if parts.len() != 3 || parts.iter().any(|p| p.is_empty()) {
            return Err(ObservationError::Incomplete.into());
        }
        self.observe_ollama_storage(
            spec,
            &format!("{}/{}/{}", parts[0], spec.volume(), parts[2]),
        )
        .await?;
        if self.container(&spec.name).await?.is_none() {
            return Ok(None);
        }
        self.observe_ollama(spec, id).await
    }
    pub async fn remove_ollama(&self, spec: &ServiceSpec, id: &str) -> Result<(), Error> {
        if let Some(service) = self.observe_ollama_removal(spec, id).await? {
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
    pub async fn observe_ollama(
        &self,
        spec: &ServiceSpec,
        id: &str,
    ) -> Result<Option<Service>, Error> {
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
                        "bound Ollama is absent; automatic recreation is forbidden",
                    ));
                }
                return Ok(None);
            };
            let volume = volume.ok_or(Error::Conflict(
                "Ollama storage observation failed; absence is unconfirmed",
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
            Ok(Some(Service {
                spec: spec.clone(),
                id: physical,
                running,
            }))
        };
        tokio::time::timeout(Duration::from_secs(20), work)
            .await
            .map_err(|_| ObservationError::Transport)?
    }
    pub async fn preflight_ollama(&self, spec: &ServiceSpec, id: &str) -> Result<(), Error> {
        match self.observe_ollama(spec, id).await {
            Err(Error::PartialRuntime) if id.is_empty() => Ok(()),
            other => other.map(|_| ()),
        }
    }
    pub async fn bound_ollama(&self, id: &str, endpoint: &str) -> Result<Service, Error> {
        let parts: Vec<_> = id.split('/').collect();
        if parts.len() != 3 || parts.iter().any(|s| s.is_empty()) {
            return Err(Error::Conflict("invalid Ollama physical binding"));
        }
        let container = self
            .container(parts[1])
            .await?
            .ok_or(Error::Conflict("bound Ollama container is unobservable"))?;
        let config = container.config.ok_or(ObservationError::Incomplete)?;
        let labels = config.labels.ok_or(ObservationError::Incomplete)?;
        let host = container.host_config.ok_or(ObservationError::Incomplete)?;
        super::Models::new(endpoint)?;
        let bind = endpoint
            .strip_prefix("http://")
            .and_then(|v| v.strip_suffix("/v1"))
            .ok_or(ObservationError::Incomplete)?;
        let spec = ServiceSpec {
            name: container
                .name
                .ok_or(ObservationError::Incomplete)?
                .trim_start_matches('/')
                .into(),
            owner: labels
                .get(OWNER_LABEL)
                .ok_or(ObservationError::Incomplete)?
                .clone(),
            generation: labels
                .get(GENERATION_LABEL)
                .ok_or(ObservationError::Incomplete)?
                .clone(),
            image: config.image.ok_or(ObservationError::Incomplete)?,
            network: host.network_mode.ok_or(ObservationError::Incomplete)?,
            bind_address: bind.into(),
        };
        self.observe_ollama(&spec, id)
            .await?
            .ok_or(Error::Conflict("bound Ollama parent is absent"))
    }
    pub async fn ensure_ollama(&self, spec: &ServiceSpec, id: &str) -> Result<Service, Error> {
        let observed = match self.observe_ollama(spec, id).await {
            Err(Error::PartialRuntime) if id.is_empty() => None,
            other => other?,
        };
        if observed.is_none() {
            if !id.is_empty() {
                return Err(Error::Conflict(
                    "bound Ollama unavailable; recreation forbidden",
                ));
            }
            if self.image(&spec.image).await?.is_none() {
                self.pull_image(&spec.image).await?;
            }
            if self.volume(&spec.volume()).await?.is_none() {
                self.api
                    .create_volume(VolumeCreateRequest {
                        name: Some(spec.volume()),
                        driver: Some("local".into()),
                        labels: Some(spec.labels()?),
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
                    "Ollama appeared during create; reapply to reconcile",
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
            .observe_ollama(spec, id)
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
        self.observe_ollama(spec, &observed.id)
            .await?
            .ok_or(ObservationError::Incomplete.into())
    }
}
#[cfg(all(test, unix))]
#[path = "service_tests.rs"]
mod tests;
