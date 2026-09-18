// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(all(test, unix))]
#[path = "gateway_storage_tests.rs"]
mod tests;

use super::{
    GATEWAY_KIND, Spec,
    keys::CREDENTIAL_KEY_PATH,
    observation::{verify_labels, verify_network, verify_volume},
};
use crate::{
    Error, ObservationError,
    docker::{Engine, remote},
};
use bollard::{
    models::{ContainerCreateBody, ContainerInspectResponse, VolumeCreateRequest},
    query_parameters::{CreateContainerOptions, WaitContainerOptions},
};
use futures_util::StreamExt;
use serde_json::json;
use sha2::{Digest, Sha256};
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn initializer(spec: &Spec, data_path: &str) -> Result<ContainerCreateBody, Error> {
    serde_json::from_value(json!({"Image":spec.image(),"User":"0:0","Labels":spec.labels()?,"Entrypoint":["/usr/local/bin/openshell-gateway"],"Cmd":["generate-certs","--output-dir",format!("{data_path}/tls"),"--server-san","127.0.0.1"],"HostConfig":{"NetworkMode":"none","CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"Mounts":[{"Type":"volume","Source":spec.volume(),"Target":data_path}]}})).map_err(|_|Error::State("invalid compiled gateway initializer"))
}
fn verify_initializer(
    spec: &Spec,
    helper: &ContainerInspectResponse,
    data_path: Option<&str>,
) -> Result<(), Error> {
    if helper.id.as_ref().is_none_or(String::is_empty) || helper.state.is_none() {
        return Err(ObservationError::Incomplete.into());
    }
    let config = helper.config.as_ref().ok_or(ObservationError::Incomplete)?;
    if config.image.as_deref() != Some(spec.image()) {
        return Err(ObservationError::BindingMismatch.into());
    }
    verify_labels(
        &spec.labels()?,
        config.labels.as_ref().ok_or(ObservationError::Incomplete)?,
    )?;
    if let Some(data_path) = data_path {
        let expected = initializer(spec, data_path)?;
        let host = helper
            .host_config
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        if config.entrypoint != expected.entrypoint
            || config.cmd != expected.cmd
            || config.user != expected.user
            || host.network_mode.as_deref() != Some("none")
            || host.privileged.unwrap_or(false)
            || host.cap_drop.as_deref() != Some(&["ALL".into()])
            || host.security_opt.as_deref() != Some(&["no-new-privileges".into()])
            || !host.cap_add.as_ref().is_none_or(Vec::is_empty)
        {
            return Err(Error::Conflict(
                "gateway initializer launch configuration drifted",
            ));
        }
        let mounts = helper.mounts.as_ref().ok_or(ObservationError::Incomplete)?;
        if mounts.len() != 1
            || mounts[0].name.as_deref() != Some(&spec.volume())
            || mounts[0].destination.as_deref() != Some(data_path)
            || mounts[0].rw != Some(true)
            || mounts[0].typ.as_ref().map(ToString::to_string).as_deref() != Some("volume")
        {
            return Err(Error::Conflict("gateway storage initializer mount changed"));
        }
    }
    Ok(())
}
impl Engine {
    pub async fn gateway_storage(
        &self,
        spec: &Spec,
        id: &str,
        create: bool,
    ) -> Result<Option<String>, Error> {
        spec.validate()?;
        if spec.kind != GATEWAY_KIND || spec.layout != 0 || self.endpoint() != spec.engine() {
            return Err(Error::Conflict(
                "invalid gateway storage specification or engine",
            ));
        }
        if spec.compute_driver == "podman" {
            #[cfg(unix)]
            {
                let native = self.podman_json("info").await?;
                let rootless = native["host"]["security"]["rootless"]
                    .as_bool()
                    .ok_or(ObservationError::Incomplete)?;
                if rootless && native["host"]["rootlessNetworkCmd"] != serde_json::json!("pasta") {
                    return Err(Error::Conflict(
                        "managed rootless Podman requires an API that reports pasta networking for OpenShell callbacks",
                    ));
                }
            }
            let version = self.api.version().await.map_err(|error| remote(&error))?;
            if !version
                .components
                .unwrap_or_default()
                .iter()
                .any(|part| part.name == "Podman Engine")
            {
                return Err(Error::Conflict(
                    "Podman sandbox driver requires a Podman engine socket",
                ));
            }
        }
        let info = self.info().await?;
        let mut volume = self.volume(&spec.volume()).await?;
        let network = self.network(&spec.network()).await?;
        let helper = self
            .managed_container(spec, &format!("{}-initialize", spec.name))
            .await?;
        if let Some(volume) = &volume {
            verify_volume(spec, volume, info.docker_root_dir.as_deref())?;
        }
        if let Some(network) = &network {
            verify_network(spec, network)?;
        }
        if let Some(helper) = &helper {
            verify_initializer(
                spec,
                helper,
                volume.as_ref().map(|volume| volume.mountpoint.as_str()),
            )?;
        }
        let missing = volume.is_none() || network.is_none() || helper.is_none();
        if missing && !id.is_empty() {
            return Err(Error::Conflict(
                "bound gateway storage dependency is missing; recreation forbidden",
            ));
        }
        if missing && !create {
            return if volume.is_none() && network.is_none() && helper.is_none() {
                Ok(None)
            } else {
                Err(Error::PartialRuntime)
            };
        }
        if missing && create {
            self.ensure_image(spec).await?;
            self.ensure_network(spec).await?;
            if volume.is_none() {
                self.api
                    .create_volume(VolumeCreateRequest {
                        name: Some(spec.volume()),
                        driver: Some("local".into()),
                        labels: Some(spec.labels()?),
                        ..Default::default()
                    })
                    .await
                    .map_err(|error| remote(&error))?;
                volume = self.volume(&spec.volume()).await?;
                verify_volume(
                    spec,
                    volume.as_ref().ok_or(ObservationError::Incomplete)?,
                    info.docker_root_dir.as_deref(),
                )?;
            }
        }
        let data_path = &volume
            .as_ref()
            .ok_or(ObservationError::Incomplete)?
            .mountpoint;
        let created = helper
            .as_ref()
            .and_then(|helper| helper.state.as_ref())
            .and_then(|state| state.status.as_ref())
            .is_some_and(|status| status.to_string() == "created");
        if created && !id.is_empty() {
            return Err(Error::Conflict(
                "bound gateway initializer has not completed; credential regeneration forbidden",
            ));
        }
        if create && (missing || created) {
            if !missing {
                self.ensure_image(spec).await?;
            }
            self.initialize_gateway(spec, data_path).await?;
            return Box::pin(self.gateway_storage(spec, id, false)).await;
        }
        if created && id.is_empty() {
            return Err(Error::PartialRuntime);
        }
        let helper = helper.ok_or(ObservationError::Incomplete)?;
        let state = helper.state.as_ref().ok_or(ObservationError::Incomplete)?;
        if state.running != Some(false) || state.exit_code != Some(0) {
            return Err(Error::Conflict(
                "gateway credential initialization is incomplete",
            ));
        }
        let helper_id = helper.id.as_deref().ok_or(ObservationError::Incomplete)?;
        let config = self
            .read_file(helper_id, &format!("{data_path}/gateway.toml"), 128 << 10)
            .await?;
        if config.is_none() && create && id.is_empty() {
            self.initialize_gateway(spec, data_path).await?;
            return Box::pin(self.gateway_storage(spec, id, false)).await;
        }
        if config.is_none() && id.is_empty() {
            return Err(Error::PartialRuntime);
        }
        if config.as_deref() != Some(spec.gateway_config(data_path).as_bytes()) {
            return Err(Error::Conflict(
                "gateway storage configuration changed or is unobservable",
            ));
        }
        let public = self
            .read_file(
                helper_id,
                &format!("{data_path}/tls/jwt/public.pem"),
                128 << 10,
            )
            .await?
            .filter(|key| !key.is_empty())
            .ok_or(Error::Conflict("gateway signing identity is unobservable"))?;
        self.credential_key(spec, helper_id, data_path, !id.is_empty(), create)
            .await?;
        let volume = volume.ok_or(ObservationError::Incomplete)?;
        let network = network.ok_or(ObservationError::Incomplete)?;
        let actual = format!(
            "{}/{}/{}/{}/{}",
            spec.binding_namespace(info.id.as_deref(), network.id.as_deref())?,
            volume.name,
            volume.created_at.ok_or(ObservationError::Incomplete)?,
            network.id.ok_or(ObservationError::Incomplete)?,
            hash(&public)
        );
        if !id.is_empty() && id != actual {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(Some(actual))
    }
    async fn credential_key(
        &self,
        spec: &Spec,
        helper: &str,
        data_path: &str,
        bound: bool,
        create: bool,
    ) -> Result<Vec<u8>, Error> {
        if let Some(key) = self
            .read_file(helper, &format!("{data_path}{CREDENTIAL_KEY_PATH}"), 32)
            .await?
        {
            if key.len() != 32 {
                return Err(Error::Conflict(
                    "gateway credential encryption key is invalid",
                ));
            }
            return Ok(key);
        }
        if bound {
            return Err(Error::Conflict(
                "gateway encryption key is missing; resources retained",
            ));
        }
        if self.managed_container(spec, &spec.name).await?.is_some() {
            return Err(Error::Conflict(
                "gateway has no persistent credential key; resources retained",
            ));
        }
        if !create {
            return Err(Error::PartialRuntime);
        }
        let mut key = vec![0_u8; 32];
        getrandom::fill(&mut key)
            .map_err(|_| Error::State("cannot generate gateway credential key"))?;
        self.write_credential_key(helper, data_path, &key).await
    }
    async fn initialize_gateway(&self, spec: &Spec, data_path: &str) -> Result<(), Error> {
        let name = format!("{}-initialize", spec.name);
        let mut helper = self.managed_container(spec, &name).await?;
        if helper.is_none() {
            let created = self
                .api
                .create_container(
                    Some(CreateContainerOptions {
                        name: Some(name.clone()),
                        ..Default::default()
                    }),
                    initializer(spec, data_path)?,
                )
                .await
                .map_err(|error| remote(&error))?;
            if created.id.is_empty() {
                return Err(ObservationError::Incomplete.into());
            }
            helper = self.managed_container(spec, &created.id).await?;
        }
        let helper = helper.ok_or(ObservationError::Incomplete)?;
        verify_initializer(spec, &helper, Some(data_path))?;
        let helper_id = helper.id.as_deref().ok_or(ObservationError::Incomplete)?;
        if helper
            .state
            .as_ref()
            .and_then(|state| state.status.as_ref())
            .is_some_and(|status| status.to_string() == "created")
        {
            self.api
                .start_container(helper_id, None)
                .await
                .map_err(|error| remote(&error))?;
        }
        let mut wait = self.api.wait_container(
            helper_id,
            Some(WaitContainerOptions {
                condition: "not-running".into(),
            }),
        );
        let status = wait
            .next()
            .await
            .ok_or(ObservationError::Incomplete)?
            .map_err(|error| remote(&error))?;
        if status.status_code != 0 || status.error.is_some() {
            return Err(Error::Conflict(
                "gateway credential initialization failed; container retained",
            ));
        }
        self.credential_key(spec, helper_id, data_path, false, true)
            .await?;
        self.write_files(
            helper_id,
            data_path,
            &[(
                "gateway.toml",
                spec.gateway_config(data_path).as_bytes(),
                0o600,
            )],
        )
        .await
    }
}
