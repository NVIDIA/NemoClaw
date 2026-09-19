// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::installers::{ollama, vllm};
use crate::{
    Error,
    managed::{GATEWAY_KIND, GATEWAY_STORAGE_KIND, Spec, Storage},
};

/// Validate a compiled resource without opening connections or reading secrets.
/// Parse errors deliberately omit serialized source values.
pub fn validate_resource_spec(kind: &str, encoded: &str) -> Result<(), Error> {
    if matches!(kind, vllm::STORAGE_KIND | ollama::STORAGE_KIND) {
        let storage: Storage = serde_json::from_str(encoded)
            .map_err(|_| Error::State("invalid managed storage specification"))?;
        return storage.validate();
    }
    if !matches!(
        kind,
        GATEWAY_KIND | GATEWAY_STORAGE_KIND | vllm::SERVICE_KIND | ollama::SERVICE_KIND
    ) {
        return Ok(());
    }
    let spec: Spec = serde_json::from_str(encoded)
        .map_err(|_| Error::State("invalid managed runtime specification"))?;
    let expected = if kind == GATEWAY_STORAGE_KIND {
        GATEWAY_KIND
    } else {
        kind
    };
    if spec.kind != expected {
        return Err(Error::Conflict(
            "runtime specification does not match the resource kind",
        ));
    }
    spec.validate()?;
    match kind {
        vllm::SERVICE_KIND => {
            vllm::configured_service(&spec)?;
        }
        ollama::SERVICE_KIND => {
            ollama::configured_service(&spec)?;
        }
        GATEWAY_KIND => spec.validate_runtime()?,
        _ => {}
    }
    Ok(())
}

/// Check hardware contracts against fresh host observations. OpenTofu may
/// replan replacements with null prior state before releasing the old process;
/// transient startup headroom and artifact space remain deployment/start checks.
pub(crate) async fn check_resource_hardware(
    engine: &crate::docker::Engine,
    spec: &Spec,
) -> Result<(), Error> {
    if engine.endpoint() != spec.engine() {
        return Err(Error::Conflict(
            "hardware engine differs from runtime specification",
        ));
    }
    let work = async {
        let host = engine.host_observer.observe(engine).await?;
        let info = engine.info().await?;
        let capacity = host.for_engine(info.id.as_deref().unwrap_or(""))?;
        match spec.kind.as_str() {
            vllm::SERVICE_KIND => vllm::hardware_capacity::check_memory(
                &vllm::configured_service(spec)?,
                &capacity,
                false,
            ),
            ollama::SERVICE_KIND => ollama::hardware_capacity::check_memory(
                &ollama::configured_service(spec)?,
                &capacity,
                false,
            ),
            _ => Err(Error::Conflict("runtime has no hardware contract")),
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), work)
        .await
        .map_err(|_| Error::State("host hardware observation timed out"))?
}
