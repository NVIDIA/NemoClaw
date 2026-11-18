// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Reads an image's Fabric catalog label through its container engine.

use crate::{
    AgentImagesObservation, FabricObservation, FabricRequirements,
    capabilities::{ImageMetadata, assess_image},
    catalog::{FabricCatalog, IMAGE_CATALOG_LABEL},
};
use nemoclaw_backend::ObservationStatus;
use nemoclaw_docker::Engines;
use std::time::Duration;

/// Inspect metadata on an existing image. This never pulls an image or starts a container.
pub async fn observe_fabric(
    engines: &dyn Engines,
    endpoint: &str,
    image: &str,
) -> FabricObservation {
    let mut observed = FabricObservation {
        status: ObservationStatus::Unknown,
        reason: None,
        source: "engine_image_inspect".into(),
        image_id: None,
        catalog: None,
        image: Default::default(),
        compatibility: None,
    };
    let work = async { engines.engine(endpoint)?.image(image).await };
    match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(Ok(Some(info))) => {
            observed.image_id = info.id;
            observed.image = ImageMetadata {
                architecture: info.architecture,
                operating_system: info.os,
                repo_digests: info.repo_digests.unwrap_or_default(),
                size_bytes: info.size,
            };
            let label = info
                .config
                .and_then(|config| config.labels)
                .and_then(|labels| labels.get(IMAGE_CATALOG_LABEL).cloned());
            match label.as_deref().map(FabricCatalog::from_json) {
                Some(Ok(catalog))
                    if observed.image_id.as_ref().is_some_and(|id| !id.is_empty()) =>
                {
                    observed.catalog = Some(catalog);
                    observed.status = ObservationStatus::Available;
                }
                Some(_) => {
                    observed.reason = Some("image Fabric metadata is invalid or incomplete".into())
                }
                None => {
                    observed.reason =
                        Some("image does not advertise Fabric capability metadata".into())
                }
            }
        }
        Ok(Ok(None)) => {
            observed.status = ObservationStatus::Unavailable;
            observed.reason = Some("image is not present on the selected engine".into());
        }
        Ok(Err(error)) => observed.reason = Some(error.to_string()),
        Err(_) => observed.reason = Some("image observation timed out".into()),
    }
    observed
}

/// List the images `endpoint` holds whose catalog label installs
/// `adapter_id`'s runtime, newest first, by digest. An image the engine
/// records without one, as Docker's classic image store does, can't be
/// pinned. This never pulls an image or starts a container.
pub async fn observe_agent_images(
    engines: &dyn Engines,
    endpoint: &str,
    adapter_id: &str,
) -> AgentImagesObservation {
    let work = async {
        engines
            .engine(endpoint)?
            .images_labeled(IMAGE_CATALOG_LABEL)
            .await
    };
    let (status, reason, mut images) =
        match tokio::time::timeout(Duration::from_secs(5), work).await {
            Ok(Ok(images)) => (ObservationStatus::Available, None, images),
            Ok(Err(error)) => (
                ObservationStatus::Unknown,
                Some(error.to_string()),
                Vec::new(),
            ),
            Err(_) => (
                ObservationStatus::Unknown,
                Some("image listing timed out".into()),
                Vec::new(),
            ),
        };
    images.sort_by_key(|image| std::cmp::Reverse(image.created));
    let references = images
        .into_iter()
        .filter(|image| {
            image
                .labels
                .get(IMAGE_CATALOG_LABEL)
                .and_then(|label| FabricCatalog::from_json(label).ok())
                .is_some_and(|catalog| {
                    catalog.runtime.is_some()
                        && catalog
                            .adapters
                            .iter()
                            .any(|adapter| adapter.adapter_id() == adapter_id)
                })
        })
        .filter_map(|image| {
            image
                .repo_digests
                .into_iter()
                .find(|reference| reference.contains("@sha256:"))
        })
        .collect();
    AgentImagesObservation {
        status,
        reason,
        references,
    }
}

/// Judge an image read against what its sandbox requires, on the engine
/// platform when one is known.
pub fn judge_image(
    observed: &mut FabricObservation,
    image: &str,
    requirements: &FabricRequirements,
    architecture: Option<&str>,
    operating_system: Option<&str>,
) {
    observed.compatibility = Some(assess_image(
        observed.catalog.as_ref(),
        requirements,
        &observed.image,
        image,
        architecture,
        operating_system,
    ));
}
