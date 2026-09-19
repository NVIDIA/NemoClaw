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
