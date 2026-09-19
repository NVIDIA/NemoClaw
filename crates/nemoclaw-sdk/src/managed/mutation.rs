// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(all(test, unix))]
#[path = "mutation_tests.rs"]
mod tests;

use super::{
    GATEWAY_KIND, RuntimeObservation, Spec,
    observation::{verify_network, verify_volume},
};
use crate::{
    Error, ObservationError,
    docker::{Engine, remote},
};
use bollard::{
    models::{NetworkCreateRequest, NetworkInspect, VolumeCreateRequest},
    query_parameters::{CreateContainerOptions, CreateImageOptions, StopContainerOptions},
};
use futures_util::StreamExt;
use serde_json::json;

const MISSING_IMAGE: &str = "image is absent from the selected engine and imagePullPolicy is Never; load the pinned image there or allow pulling";

fn image_pull_policy(spec: &Spec) -> crate::config::ImagePullPolicy {
    use crate::config::ImagePullPolicy;
    spec.process.as_ref().map_or_else(
        || spec.gateway.image_pull_policy.unwrap_or_default(),
        |process| {
            process.image_pull_policy.unwrap_or(if process.pull_image {
                ImagePullPolicy::IfNotPresent
            } else {
                ImagePullPolicy::Never
            })
        },
    )
}
#[async_trait::async_trait]
trait CapacityCheck: Sync {
    async fn check(
        &self,
        engine: &Engine,
        spec: &Spec,
        observed: Option<&RuntimeObservation>,
    ) -> Result<(), Error>;
}
struct HostCapacity;
#[async_trait::async_trait]
impl CapacityCheck for HostCapacity {
    async fn check(
        &self,
        engine: &Engine,
        spec: &Spec,
        observed: Option<&RuntimeObservation>,
    ) -> Result<(), Error> {
        crate::services::check_process_capacity(engine, spec, observed).await
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
        capacity: &dyn CapacityCheck,
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
        if spec.process.is_some() {
            capacity.check(self, spec, observed.as_ref()).await?;
        }
        if observed.is_some() {
            self.ensure_image(spec).await?;
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
            "cannot observe the runtime after starting it; keep the state directory and run apply again with the same configuration",
        ))
    }
    pub(crate) async fn ensure_image(&self, spec: &Spec) -> Result<(), Error> {
        let image = self
            .acquire_image(spec.image(), image_pull_policy(spec))
            .await?;
        self.validate_runtime_image(spec, &image).await
    }
    /// Inspect the pinned local image without pulling. Apply validates it again
    /// after acquisition, including images that are absent during planning.
    pub(crate) async fn check_planned_image(&self, spec: &Spec) -> Result<(), Error> {
        match self.image(spec.image()).await? {
            Some(image) => self.validate_runtime_image(spec, &image).await,
            None if image_pull_policy(spec) == crate::config::ImagePullPolicy::Never => {
                Err(Error::Conflict(MISSING_IMAGE))
            }
            None => Ok(()),
        }
    }
    async fn validate_runtime_image(
        &self,
        spec: &Spec,
        image: &bollard::models::ImageInspect,
    ) -> Result<(), Error> {
        if spec.process.is_some() {
            spec.validate_process_image(image)?;
        } else {
            let engine = self.info().await?;
            if image.id.as_ref().is_none_or(String::is_empty)
                || !gateway_architecture_matches(
                    image.architecture.as_deref(),
                    engine.architecture.as_deref(),
                )
                || image.os.as_deref() != Some("linux")
            {
                return Err(Error::Conflict(
                    "runtime image is unavailable or incompatible with the execution target",
                ));
            }
        }
        Ok(())
    }
    pub(crate) async fn acquire_image(
        &self,
        reference: &str,
        policy: crate::config::ImagePullPolicy,
    ) -> Result<bollard::models::ImageInspect, Error> {
        use crate::config::ImagePullPolicy;
        let mut image = self.image(reference).await?;
        if policy == ImagePullPolicy::Always
            || (policy == ImagePullPolicy::IfNotPresent && image.is_none())
        {
            self.pull_image(reference).await?;
            image = self.image(reference).await?;
        }
        image.ok_or(Error::Conflict(MISSING_IMAGE))
    }
    pub(crate) async fn pull_image(&self, image: &str) -> Result<(), Error> {
        use crate::{
            ByteProgress, DownloadPhase,
            download::{Reporter, layer_id},
        };
        let mut progress = Reporter::new(image);
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
            // Never forward registry text. Only known phases and digest-like IDs
            // are progress; authoritative errors continue through the pull result.
            let phase = match event.status.as_deref() {
                Some("Downloading") => Some(DownloadPhase::Downloading),
                Some("Extracting") => Some(DownloadPhase::Extracting),
                Some("Verifying Checksum") => Some(DownloadPhase::Verifying),
                Some("Pull complete" | "Already exists") => Some(DownloadPhase::Complete),
                _ => None,
            };
            if let (Some(phase), Some(layer)) = (phase, layer_id(event.id.as_deref())) {
                let bytes = event.progress_detail.and_then(|detail| {
                    Some(ByteProgress {
                        completed: u64::try_from(detail.current?).ok()?,
                        total: detail
                            .total
                            .and_then(|total| u64::try_from(total).ok())
                            .filter(|total| *total > 0),
                    })
                });
                progress.report(Some(layer), phase, bytes);
            }
        }
        if self.image(image).await?.is_none() {
            return Err(Error::Conflict("pinned image pull incomplete"));
        }
        progress.complete();
        Ok(())
    }
    /// Shared gateway networks can be created by a dependency in the same apply.
    /// Validate an existing network; defer shared-network absence until creation.
    pub(crate) async fn check_planned_network(&self, spec: &Spec) -> Result<(), Error> {
        if spec.kind == GATEWAY_KIND
            || spec
                .process
                .as_ref()
                .is_some_and(|process| process.create_network)
        {
            self.checked_network(spec).await?;
        } else if let Some(network) = self.network(&spec.network()).await? {
            verify_network(spec, &network)?;
        }
        Ok(())
    }
    /// Observe an owned network, or check that its subnet is available for creation.
    /// This performs no mutations and must be repeated immediately before creation.
    pub(crate) async fn checked_network(
        &self,
        spec: &Spec,
    ) -> Result<Option<NetworkInspect>, Error> {
        if let Some(network) = self.network(&spec.network()).await? {
            verify_network(spec, &network)?;
            return Ok(Some(network));
        }
        if spec.kind != GATEWAY_KIND
            && spec
                .process
                .as_ref()
                .is_none_or(|process| !process.create_network)
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
        Ok(None)
    }
    pub(crate) async fn ensure_network(&self, spec: &Spec) -> Result<(), Error> {
        if self.checked_network(spec).await?.is_some() {
            return Ok(());
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
        if (spec.kind != GATEWAY_KIND && spec.process.is_none()) || id.is_empty() {
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
