// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
pub mod authentication;
mod registry;
pub use registry::BackendRegistry;
pub(crate) mod capacity;
pub use capacity::{ServiceCapacity, observe_service_capacity, validate_capacity_specs};
mod readiness;
mod status;
pub use readiness::{validate_readiness_spec, wait_service_ready};
pub mod installers;
use nemoclaw_sdk::services::validate_resource_spec;

/// Provider definition for an installer-owned SDK resource schema.
pub(crate) fn schema_definition(kind: &str) -> crate::Definition {
    let schema = nemoclaw_sdk::services::resource_schemas()
        .into_iter()
        .find(|schema| schema.kind == kind)
        .unwrap_or_else(|| panic!("the SDK defines no {kind} resource schema"));
    crate::Definition::new(schema.kind, schema.fields, schema.mutable)
}

/// Installer-owned service storage and external model resources.
pub(crate) fn definitions() -> [crate::Definition; 4] {
    use nemoclaw_sdk::services::installers::{ollama, vllm};
    [
        schema_definition(ollama::proxy::STORAGE),
        schema_definition(ollama::proxy::MODEL)
            .describe(installers::ollama::proxy::describe_model_error),
        schema_definition(ollama::STORAGE_KIND).validate_attribute(crate::managed::Storage::check),
        schema_definition(vllm::STORAGE_KIND).validate_attribute(crate::managed::Storage::check),
    ]
}
