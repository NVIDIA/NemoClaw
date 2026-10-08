// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
pub mod authentication;
pub(crate) mod inputs;
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

/// Omitted owner and generation are generated on create.
fn generated_identity(definition: crate::Definition) -> crate::Definition {
    definition
        .generated("owner", nemoclaw_backend::generate_owner)
        .generated("generation", nemoclaw_backend::generate_generation)
}

/// Service storage whose omitted identity the provider generates on create.
fn storage_definition(kind: &str) -> crate::Definition {
    generated_identity(schema_definition(kind).validate_attribute(crate::managed::Storage::check))
}

/// Installer-owned service storage and external model resources.
pub(crate) fn definitions() -> [crate::Definition; 5] {
    use nemoclaw_sdk::services::installers::{ollama, vllm};
    [
        inputs::definition(),
        generated_identity(schema_definition(ollama::proxy::STORAGE)),
        generated_identity(
            schema_definition(ollama::proxy::MODEL)
                .describe(installers::ollama::proxy::describe_model_error),
        ),
        storage_definition(ollama::STORAGE_KIND),
        storage_definition(vllm::STORAGE_KIND),
    ]
}
