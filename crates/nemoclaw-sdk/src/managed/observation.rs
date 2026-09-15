// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(all(test, unix))]
#[path = "observation_tests.rs"]
mod tests;

use super::{GATEWAY_KIND, GENERATION_LABEL, OWNER_LABEL, SERVICE_KIND, SUPERVISOR_SHA256, Spec};
use crate::{Error, ObservationError, docker::Engine};
use bollard::models::{ContainerInspectResponse, NetworkInspect, Volume};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    time::Duration,
};
#[derive(Clone, Debug)]
pub struct RuntimeObservation {
    pub spec: Spec,
    pub id: String,
    pub container_id: String,
    pub data_path: String,
    pub running: bool,
    pub started_at: String,
}
pub(crate) fn verify_labels(
    want: &HashMap<String, String>,
    actual: &HashMap<String, String>,
) -> Result<(), Error> {
    if want
        .iter()
        .any(|(key, value)| value.is_empty() || actual.get(key) != Some(value))
    {
        return Err(ObservationError::BindingMismatch.into());
    }
    Ok(())
}
pub(crate) fn verify_volume(
    spec: &Spec,
    volume: &Volume,
    data_root: Option<&str>,
) -> Result<(), Error> {
    let canonical = |path: &str| {
        path.starts_with('/')
            && path
                .split('/')
                .skip(1)
                .all(|part| !matches!(part, "" | "." | ".."))
    };
    let root = data_root
        .filter(|root| canonical(root))
        .ok_or(ObservationError::Incomplete)?;
    verify_labels(
        &[
            (OWNER_LABEL.into(), spec.owner.clone()),
            (GENERATION_LABEL.into(), spec.generation.clone()),
        ]
        .into(),
        &volume.labels,
    )?;
    if volume.name != spec.volume()
        || volume.created_at.as_ref().is_none_or(String::is_empty)
        || volume.driver != "local"
        || !volume.options.is_empty()
        || !canonical(&volume.mountpoint)
        || !volume.mountpoint.starts_with(&format!("{root}/volumes/"))
        || !volume.mountpoint.ends_with("/_data")
    {
        return Err(Error::Conflict(
            "managed persistent volume identity or configuration drifted",
        ));
    }
    Ok(())
}
pub(crate) fn verify_network(spec: &Spec, network: &NetworkInspect) -> Result<(), Error> {
    let labels = network
        .labels
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    let ipam = network.ipam.as_ref().ok_or(ObservationError::Incomplete)?;
    let config = ipam.config.as_ref().ok_or(ObservationError::Incomplete)?;
    if labels.get(OWNER_LABEL) != Some(&spec.owner)
        || network.id.as_ref().is_none_or(String::is_empty)
        || network.name.as_ref() != Some(&spec.network())
        || network.driver.as_deref() != Some("bridge")
        || network.internal.unwrap_or(false)
        || network.enable_ipv6.unwrap_or(false)
        || ipam.driver.as_deref() != Some("default")
        || config.len() != 1
        || config[0].subnet.as_deref() != Some(spec.network_cidr())
        || config[0].gateway.as_deref() != Some(&spec.bridge())
    {
        return Err(Error::Conflict(
            "managed bridge identity, ownership or configuration drifted",
        ));
    }
    if spec.kind == GATEWAY_KIND {
        verify_labels(
            &[
                (OWNER_LABEL.into(), spec.owner.clone()),
                (GENERATION_LABEL.into(), spec.generation.clone()),
            ]
            .into(),
            labels,
        )?;
    }
    Ok(())
}
fn normalized(mut value: Value) -> Value {
    match &mut value {
        Value::Object(map) => {
            map.retain(|_, value| !value.is_null());
            for value in map.values_mut() {
                *value = normalized(value.take());
            }
        }
        Value::Array(values) => {
            for value in values {
                *value = normalized(value.take());
            }
        }
        _ => {}
    }
    value
}
fn list(value: &Value) -> Value {
    if value.is_null() {
        json!([])
    } else {
        normalized(value.clone())
    }
}
fn environment(values: Option<&Vec<String>>) -> BTreeMap<String, String> {
    values
        .into_iter()
        .flatten()
        .map(|value| {
            let (key, value) = value.split_once('=').unwrap_or((value, ""));
            (key.into(), value.into())
        })
        .collect()
}
pub(crate) fn verify_container(
    spec: &Spec,
    container: &ContainerInspectResponse,
    data_path: &str,
    image_env: Option<&Vec<String>>,
    image_id: &str,
) -> Result<(), Error> {
    if container.id.as_ref().is_none_or(String::is_empty)
        || container
            .state
            .as_ref()
            .and_then(|state| state.running)
            .is_none()
    {
        return Err(ObservationError::Incomplete.into());
    }
    let config = container
        .config
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    let host = container
        .host_config
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    verify_labels(
        &spec.labels()?,
        config.labels.as_ref().ok_or(ObservationError::Incomplete)?,
    )?;
    let expected = spec.container(data_path)?;
    let expected_host = expected
        .host_config
        .as_ref()
        .expect("compiled host configuration");
    if container
        .name
        .as_deref()
        .map(|name| name.trim_start_matches('/'))
        != Some(&spec.name)
        || container.image.as_deref() != Some(image_id)
        || config.image != expected.image
        || config.user.as_deref().unwrap_or("") != expected.user.as_deref().unwrap_or("")
        || config.entrypoint.as_deref().unwrap_or(&[])
            != expected.entrypoint.as_deref().unwrap_or(&[])
        || config.cmd.as_deref().unwrap_or(&[]) != expected.cmd.as_deref().unwrap_or(&[])
        || host.network_mode != expected_host.network_mode
        || host.privileged.unwrap_or(false)
        || !host.cap_add.as_ref().is_none_or(Vec::is_empty)
        || host.auto_remove.unwrap_or(false)
        || !host.pid_mode.as_deref().unwrap_or("").is_empty()
        || !matches!(host.ipc_mode.as_deref().unwrap_or(""), "" | "private")
        || !host.devices.as_ref().is_none_or(Vec::is_empty)
        || host.memory.unwrap_or(0) != expected_host.memory.unwrap_or(0)
        || host.memory_swap.unwrap_or(0) != expected_host.memory_swap.unwrap_or(0)
    {
        return Err(Error::Conflict(
            "managed container configuration or memory protection drifted",
        ));
    }
    let actual = serde_json::to_value(host).map_err(|_| ObservationError::Incomplete)?;
    let expected_json = serde_json::to_value(expected_host).expect("host serialization");
    for field in ["CapDrop", "SecurityOpt", "DeviceRequests", "Ulimits"] {
        if list(&actual[field]) != list(&expected_json[field]) {
            return Err(Error::Conflict(
                "managed runtime limits or protection drifted",
            ));
        }
    }
    if normalized(actual["PortBindings"].clone())
        .as_object()
        .filter(|map| !map.is_empty())
        != normalized(expected_json["PortBindings"].clone())
            .as_object()
            .filter(|map| !map.is_empty())
    {
        return Err(Error::Conflict("managed port binding drifted"));
    }
    let restart = host
        .restart_policy
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    if restart.name != expected_host.restart_policy.as_ref().unwrap().name
        || restart.maximum_retry_count.unwrap_or(0) != 0
    {
        return Err(Error::Conflict("managed runtime restart policy drifted"));
    }
    if spec.kind == SERVICE_KIND && host.shm_size != expected_host.shm_size {
        return Err(Error::Conflict("inference shared memory policy drifted"));
    }
    let mut expected_env = environment(image_env);
    expected_env.extend(environment(expected.env.as_ref()));
    if environment(config.env.as_ref()) != expected_env {
        return Err(Error::Conflict("managed runtime environment drifted"));
    }
    let mounts = container
        .mounts
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    let desired = expected_host.mounts.as_ref().expect("compiled mounts");
    if mounts.len() != desired.len() {
        return Err(Error::Conflict("managed runtime mounts drifted"));
    }
    for wanted in desired {
        if !mounts.iter().any(|actual| {
            actual.typ.as_ref().map(ToString::to_string)
                == wanted.typ.as_ref().map(ToString::to_string)
                && actual.destination == wanted.target
                && actual.rw == Some(!wanted.read_only.unwrap_or(false))
                && if wanted
                    .typ
                    .as_ref()
                    .is_some_and(|kind| kind.to_string() == "volume")
                {
                    actual.name == wanted.source
                } else {
                    actual.source == wanted.source
                }
        }) {
            return Err(Error::Conflict(
                "managed persistent storage binding drifted",
            ));
        }
    }
    Ok(())
}
impl Engine {
    pub async fn observe_runtime(
        &self,
        spec: &Spec,
        id: &str,
    ) -> Result<Option<RuntimeObservation>, Error> {
        spec.validate()?;
        if self.endpoint() != spec.engine() {
            return Err(Error::Conflict(
                "runtime engine differs from its explicit specification",
            ));
        }
        let work = async {
            let info = self.info().await?;
            let container = self.container(&spec.name).await?;
            let volume = self.volume(&spec.volume()).await?;
            let network = self.network(&spec.network()).await?;
            if container.is_none()
                && volume.is_none()
                && (spec.kind == SERVICE_KIND || network.is_none())
            {
                return if id.is_empty() {
                    Ok(None)
                } else {
                    Err(Error::Conflict(
                        "bound managed runtime disappeared; automatic replacement forbidden",
                    ))
                };
            }
            if container.is_none() && (volume.is_some() || network.is_some()) {
                if let Some(volume) = &volume {
                    verify_volume(spec, volume, info.docker_root_dir.as_deref())?;
                }
                if let Some(network) = &network {
                    verify_network(spec, network)?;
                }
                return Err(if id.is_empty() {
                    Error::PartialRuntime
                } else {
                    Error::Conflict(
                        "bound container missing; persistent data retained and recreation forbidden",
                    )
                });
            }
            let container = container.ok_or(ObservationError::Incomplete)?;
            let volume = volume.ok_or(ObservationError::Incomplete)?;
            let network = network.ok_or(ObservationError::Incomplete)?;
            verify_volume(spec, &volume, info.docker_root_dir.as_deref())?;
            verify_network(spec, &network)?;
            let image = self
                .image(
                    container
                        .image
                        .as_deref()
                        .ok_or(ObservationError::Incomplete)?,
                )
                .await?
                .ok_or(ObservationError::Incomplete)?;
            let image_config = image.config.as_ref().ok_or(ObservationError::Incomplete)?;
            let image_id = image
                .id
                .as_deref()
                .filter(|id| !id.is_empty())
                .ok_or(ObservationError::Incomplete)?;
            verify_container(
                spec,
                &container,
                &volume.mountpoint,
                image_config.env.as_ref(),
                image_id,
            )?;
            let container_id = container.id.ok_or(ObservationError::Incomplete)?;
            let mut actual = format!(
                "{}/{}/{}/{}",
                info.id.ok_or(ObservationError::Incomplete)?,
                container_id,
                volume.created_at.ok_or(ObservationError::Incomplete)?,
                network.id.ok_or(ObservationError::Incomplete)?
            );

            if spec.kind == GATEWAY_KIND {
                if self
                    .read_file(
                        &container_id,
                        &format!("{}/gateway.toml", volume.mountpoint),
                        128 << 10,
                    )
                    .await?
                    .as_deref()
                    != Some(spec.gateway_config(&volume.mountpoint).as_bytes())
                {
                    return Err(Error::Conflict(
                        "managed gateway configuration changed or is unobservable",
                    ));
                }
                let signing = self
                    .read_file(
                        &container_id,
                        &format!("{}/tls/jwt/public.pem", volume.mountpoint),
                        128 << 10,
                    )
                    .await?
                    .ok_or(ObservationError::Incomplete)?;
                let encryption = if spec.layout >= 2 {
                    Some(
                        self.read_file(
                            &container_id,
                            &format!(
                                "{}/state/openshell/gateway/credentials/key-encryption-key.bin",
                                volume.mountpoint
                            ),
                            32,
                        )
                        .await?
                        .ok_or(ObservationError::Incomplete)?,
                    )
                } else {
                    None
                };
                actual = gateway_identity(&actual, &signing, encryption.as_deref(), spec.layout)?;
                let supervisor = self
                    .read_file(
                        &container_id,
                        &format!("{}/openshell-sandbox", volume.mountpoint),
                        128 << 20,
                    )
                    .await?
                    .ok_or(ObservationError::Incomplete)?;
                let digest: String = Sha256::digest(supervisor)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                if digest != SUPERVISOR_SHA256 {
                    return Err(Error::Conflict("gateway supervisor artifact changed"));
                }
            }
            if !id.is_empty() && id != actual {
                return Err(ObservationError::BindingMismatch.into());
            }
            let state = container.state.ok_or(ObservationError::Incomplete)?;
            Ok(Some(RuntimeObservation {
                spec: spec.clone(),
                id: actual,
                container_id,
                data_path: volume.mountpoint,
                running: state.running.ok_or(ObservationError::Incomplete)?,
                started_at: state.started_at.unwrap_or_default(),
            }))
        };
        tokio::time::timeout(Duration::from_secs(20), work)
            .await
            .map_err(|_| ObservationError::Transport)?
    }
    pub async fn observe_removal(
        &self,
        spec: &Spec,
        id: &str,
    ) -> Result<Option<RuntimeObservation>, Error> {
        if id.is_empty() {
            return Err(Error::Conflict(
                "runtime deletion requires an established identity",
            ));
        }
        let info = self.info().await?;
        if !id.starts_with(&format!(
            "{}/",
            info.id.ok_or(ObservationError::Incomplete)?
        )) {
            return Err(ObservationError::BindingMismatch.into());
        }
        match self.observe_runtime(spec, "").await {
            Err(Error::PartialRuntime) => Ok(None),
            Ok(Some(observed)) if observed.id != id => {
                Err(ObservationError::BindingMismatch.into())
            }
            result => result,
        }
    }
}

fn gateway_identity(
    base: &str,
    signing: &[u8],
    encryption: Option<&[u8]>,
    layout: u32,
) -> Result<String, Error> {
    if signing.is_empty() {
        return Err(Error::Conflict("gateway signing identity is unobservable"));
    }
    let digest = |bytes: &[u8]| -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    };
    let mut id = format!("{base}/{}", digest(signing));
    if layout >= 2 {
        let encryption = encryption
            .filter(|key| key.len() == 32)
            .ok_or(Error::Conflict(
                "gateway credential encryption key is unobservable; restart forbidden",
            ))?;
        id.push('/');
        id.push_str(&digest(encryption));
    }
    Ok(id)
}
