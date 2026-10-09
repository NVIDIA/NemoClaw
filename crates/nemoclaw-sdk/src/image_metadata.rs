// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Runtime image verification with SDK-owned service configuration.
use nemoclaw_backend::{ObservationError, Secrets};
use std::collections::BTreeMap;

pub use nemoclaw_fabric::image_metadata::{MAX_BUNDLE_BYTES, observe, verify};

/// Verify declared cluster runtime images before reconciling runtime resources.
pub fn verify_cluster_runtime_images(
    document: &crate::config::Document,
    secrets: &dyn Secrets,
) -> Result<(), ObservationError> {
    use crate::services::ServiceDefinition;
    use nemoclaw_runtime::RuntimeSpec;
    for service in document.spec.services.values() {
        let Some(settings) = service.kubernetes() else {
            continue;
        };
        let (image, architecture, runtime) = match service {
            ServiceDefinition::Vllm(service) => (
                service.image.as_str(),
                service
                    .architecture()
                    .map_err(|_| ObservationError::Incomplete)?,
                RuntimeSpec::Vllm(Box::new(service.runtime.clone())),
            ),
            ServiceDefinition::Ollama(service) => (
                service.image.as_str(),
                service
                    .architecture()
                    .map_err(|_| ObservationError::Incomplete)?,
                RuntimeSpec::Ollama(Box::new(service.runtime.clone())),
            ),
            ServiceDefinition::OllamaProxy(_) => return Err(ObservationError::Incomplete),
        };
        observe_runtime(
            secrets,
            &settings.image_metadata.env,
            image,
            architecture,
            &runtime,
        )?;
    }
    Ok(())
}

/// Verify one service image using its explicitly referenced local metadata bundle.
pub fn observe_runtime(
    secrets: &dyn Secrets,
    name: &str,
    image: &str,
    architecture: &str,
    runtime: &nemoclaw_runtime::RuntimeSpec,
) -> Result<(), ObservationError> {
    let (backend, mut required) = match runtime {
        nemoclaw_runtime::RuntimeSpec::Vllm(service) => {
            let mut labels = service
                .recipe
                .as_ref()
                .map(|recipe| recipe.compatibility.image_labels.clone())
                .unwrap_or_default();
            if service.authentication.is_some() {
                labels.insert(
                    "org.nemoclaw.inference.authentication".into(),
                    "bearer-v1".into(),
                );
            }
            ("vllm", labels)
        }
        nemoclaw_runtime::RuntimeSpec::Ollama(_) => ("ollama", BTreeMap::new()),
    };
    // Mandatory labels override recipe declarations, matching the Docker installer.
    required.insert(
        nemoclaw_runtime::SPEC_VERSION_LABEL.into(),
        nemoclaw_runtime::SPEC_VERSION.into(),
    );
    required.insert("org.nemoclaw.backend".into(), backend.into());
    nemoclaw_fabric::image_metadata::verify_runtime_labels(
        secrets,
        name,
        image,
        architecture,
        &required,
    )
}

#[cfg(test)]
mod tests;
