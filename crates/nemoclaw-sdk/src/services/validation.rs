// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::installers::{ollama, vllm};
use crate::{
    Error,
    managed::{GATEWAY_KIND, GATEWAY_STORAGE_KIND, Spec},
};

/// Validate a compiled resource without opening connections or reading secrets.
/// Parse errors deliberately omit serialized source values.
pub fn validate_resource_spec(kind: &str, encoded: &str) -> Result<(), Error> {
    if matches!(
        kind,
        crate::kubernetes::STORAGE_KIND
            | crate::kubernetes::GATEWAY_KIND
            | crate::kubernetes::AUTH_KIND
    ) {
        let spec = crate::kubernetes::Spec::decode(encoded)?;
        if spec.kind != kind {
            return Err(Error::Conflict(
                "Kubernetes specification does not match the resource kind",
            ));
        }
        return spec.validate();
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
