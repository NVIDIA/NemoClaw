// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(all(test, unix))]
#[path = "mutation_tests.rs"]
mod tests;

use super::{
    GATEWAY_KIND, RuntimeObservation, SERVICE_KIND, Spec,
    observation::{verify_network, verify_volume},
};
use crate::{
    Error, ObservationError,
    docker::{Engine, remote},
};
use bollard::{
    models::{NetworkCreateRequest, VolumeCreateRequest},
    query_parameters::{CreateContainerOptions, CreateImageOptions, StopContainerOptions},
};
use futures_util::StreamExt;
use serde_json::json;
#[async_trait::async_trait]
trait CapacityGate: Sync {
    async fn check(
        &self,
        engine: &Engine,
        spec: &Spec,
        observed: Option<&RuntimeObservation>,
    ) -> Result<(), Error>;
}
struct HostCapacity;
#[async_trait::async_trait]
impl CapacityGate for HostCapacity {
    async fn check(
        &self,
        engine: &Engine,
        spec: &Spec,
        observed: Option<&RuntimeObservation>,
    ) -> Result<(), Error> {
        engine.check_capacity(spec, observed).await
    }
}
impl Engine {
    pub async fn ensure_runtime(&self, spec: &Spec, id: &str) -> Result<RuntimeObservation, Error> {
        self.ensure_runtime_checked(spec, id, &HostCapacity).await
    }
    async fn ensure_runtime_checked(
        &self,
        spec: &Spec,
        id: &str,
        capacity: &dyn CapacityGate,
    ) -> Result<RuntimeObservation, Error> {
        let observed = match self.observe_runtime(spec, id).await {
            Err(Error::PartialRuntime) => None,
            result => result?,
        };
        if let Some(observed) = &observed
            && observed.running
        {
            return Ok(observed.clone());
        }
        if spec.kind == SERVICE_KIND {
            capacity.check(self, spec, observed.as_ref()).await?;
        }
        if observed.is_none() {
            if !id.is_empty() {
                return Err(Error::Conflict("bound runtime missing; resources retained"));
            }
            self.ensure_image(spec).await?;
            self.ensure_network(spec).await?;
            let mut volume = self.volume(&spec.volume()).await?;
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
            }
            let volume = volume.ok_or(ObservationError::Incomplete)?;
            verify_volume(spec, &volume, self.info().await?.docker_root_dir.as_deref())?;
            let created = self
                .api
                .create_container(
                    Some(CreateContainerOptions {
                        name: Some(spec.name.clone()),
                        ..Default::default()
                    }),
                    spec.container(&volume.mountpoint)?,
                )
                .await
                .map_err(|error| remote(&error))?;
            if created.id.is_empty() {
                return Err(ObservationError::Incomplete.into());
            }
        }
        // Start only the freshly observed immutable container ID. A lost create
        // or start reply is reconciled by the next explicit apply, never retried.
        let observed = self
            .observe_runtime(spec, id)
            .await?
            .ok_or(Error::Conflict(
                "runtime changed before start; retained for inspection",
            ))?;
        if !observed.running {
            self.api
                .start_container(&observed.container_id, None)
                .await
                .map_err(|error| remote(&error))?;
        }
        self.observe_runtime(spec, id).await?.ok_or(Error::Conflict(
            "started runtime is unobservable; retain intent",
        ))
    }
    pub(crate) async fn ensure_image(&self, spec: &Spec) -> Result<(), Error> {
        let mut image = self.image(spec.image()).await?;
        if image.is_none() {
            if spec.kind == SERVICE_KIND {
                return Err(Error::Conflict(
                    "pinned Spark artifact is not loaded; build the reproducible runtime locally",
                ));
            }
            self.pull_image(spec.image()).await?;
            image = self.image(spec.image()).await?;
        }
        let image = image.ok_or(ObservationError::Incomplete)?;
        spec.validate_image_authentication(&image)?;
        let architecture = image.architecture.as_deref();
        let architecture_matches = if let Some(service) = &spec.service {
            architecture
                == Some(
                    service
                        .hardware
                        .as_ref()
                        .map(|hardware| hardware.architecture.as_str())
                        .or_else(|| {
                            service
                                .recipe
                                .as_ref()
                                .map(|recipe| recipe.compatibility.architecture.as_str())
                        })
                        .unwrap_or("arm64"),
                )
        } else {
            let engine = self.info().await?;
            gateway_architecture_matches(architecture, engine.architecture.as_deref())
        };
        if image.id.as_ref().is_none_or(String::is_empty)
            || !architecture_matches
            || image.os.as_deref() != Some("linux")
        {
            return Err(Error::Conflict(
                "runtime image is unavailable or incompatible with the execution target",
            ));
        }
        if let Some(service) = &spec.service {
            let labels = image
                .config
                .as_ref()
                .and_then(|config| config.labels.as_ref())
                .ok_or(ObservationError::Incomplete)?;
            if let Some(recipe) = &service.recipe
                && recipe
                    .compatibility
                    .image_labels
                    .iter()
                    .any(|(key, value)| labels.get(key) != Some(value))
            {
                return Err(Error::Conflict(
                    "runtime image lacks declared recipe capabilities",
                ));
            }
            if labels.get("org.nemoclaw.backend").map(String::as_str)
                != Some(crate::config::constraints::BACKEND)
            {
                return Err(Error::Conflict(
                    "image does not contain the pinned Spark backend",
                ));
            }
        }
        Ok(())
    }
    pub(crate) async fn pull_image(&self, image: &str) -> Result<(), Error> {
        let options = CreateImageOptions {
            from_image: Some(image.into()),
            ..Default::default()
        };
        let mut stream = self.api.create_image(Some(options), None, None);
        while let Some(event) = stream.next().await {
            let event = event.map_err(|error| remote(&error))?;
            if event.error_detail.is_some() {
                return Err(Error::Conflict(
                    "pinned image pull failed; inspect retained engine state",
                ));
            }
        }
        if self.image(image).await?.is_none() {
            return Err(Error::Conflict("pinned image pull incomplete"));
        }
        Ok(())
    }
    pub(crate) async fn ensure_network(&self, spec: &Spec) -> Result<(), Error> {
        if let Some(network) = self.network(&spec.network()).await? {
            return verify_network(spec, &network);
        }
        if spec.kind != GATEWAY_KIND && spec.service.as_ref().is_none_or(|s| s.placement.is_none())
        {
            return Err(Error::Conflict("managed gateway network is absent"));
        }
        let networks = self
            .api
            .list_networks(None)
            .await
            .map_err(|error| remote(&error))?;
        let desired = spec
            .network_cidr()
            .parse::<ipnet::Ipv4Net>()
            .map_err(|_| Error::Conflict("invalid gateway subnet"))?;
        for network in networks {
            for config in network
                .ipam
                .and_then(|ipam| ipam.config)
                .unwrap_or_default()
            {
                if let Some(subnet) = config
                    .subnet
                    .and_then(|subnet| subnet.parse::<ipnet::Ipv4Net>().ok())
                    && (desired.contains(&subnet.network()) || subnet.contains(&desired.network()))
                {
                    return Err(Error::Conflict(
                        "managed gateway subnet overlaps an existing Docker network",
                    ));
                }
            }
        }
        let request:NetworkCreateRequest=serde_json::from_value(json!({"Name":spec.network(),"Driver":"bridge","Labels":spec.labels()?,"IPAM":{"Driver":"default","Config":[{"Subnet":spec.network_cidr(),"Gateway":spec.bridge()?}]}})).map_err(|_|Error::State("invalid compiled gateway network"))?;
        self.api
            .create_network(request)
            .await
            .map_err(|error| remote(&error))?;
        let network = self
            .network(&spec.network())
            .await?
            .ok_or(ObservationError::Incomplete)?;
        verify_network(spec, &network)
    }
    pub async fn replace_runtime(&self, spec: &Spec, id: &str) -> Result<(), Error> {
        if !matches!(spec.kind.as_str(), GATEWAY_KIND | SERVICE_KIND) || id.is_empty() {
            return Err(Error::Conflict(
                "only a bound managed process container may be replaced",
            ));
        }
        let observed = self
            .observe_runtime(spec, id)
            .await?
            .ok_or(ObservationError::Incomplete)?;
        if observed.running {
            self.api
                .stop_container(
                    &observed.container_id,
                    Some(StopContainerOptions {
                        t: Some(60),
                        ..Default::default()
                    }),
                )
                .await
                .map_err(|error| remote(&error))?;
        }
        self.api
            .remove_container(&observed.container_id, None)
            .await
            .map_err(|error| remote(&error))
    }
    pub async fn remove_runtime(&self, spec: &Spec, id: &str) -> Result<(), Error> {
        if self.observe_removal(spec, id).await?.is_none() {
            return Ok(());
        }
        self.replace_runtime(spec, id).await?;
        if self.observe_removal(spec, id).await?.is_some() {
            return Err(Error::Conflict(
                "runtime deletion was not confirmed; retain state and rerun destroy",
            ));
        }
        Ok(())
    }
}

fn gateway_architecture_matches(image: Option<&str>, engine: Option<&str>) -> bool {
    matches!(
        (image, engine),
        (Some("amd64"), Some("amd64" | "x86_64")) | (Some("arm64"), Some("arm64" | "aarch64"))
    )
}
