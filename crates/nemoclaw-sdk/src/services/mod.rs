// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Managed package installers selected by `spec.services`.
//!
//! The deployment core consumes package-independent install plans. Consumer
//! bindings, package dispatch, readiness checks, and destroy policy remain here.

pub(crate) mod authentication;
pub(crate) mod capacity;
mod contract;
pub use capacity::{ServiceCapacity, observe_service_capacity, validate_capacity_specs};
pub mod installers;
mod readiness;
mod registry;
pub(crate) use readiness::configure_service_readiness;
pub use readiness::{validate_readiness_spec, wait_service_ready};
#[cfg(target_os = "linux")]
mod runtime;
mod validation;
pub use validation::validate_resource_spec;

pub(crate) use contract::{InstallStage, MANAGED_SERVICE_KIND};
pub use installers::ollama::{
    ExternalOllama, ExternalOllamaModel, ManagedOllama, OllamaMemory, OllamaModel, OllamaProxy,
    OllamaServing,
};
pub(crate) use registry::InstallPlans;
pub use registry::{
    BackendRegistry, RegisteredBackend, ResourceBehavior, ResourceSchema, ServiceDefinition,
    resource_behavior, resource_schemas,
};
pub(crate) use registry::{
    constrain_schema, credential_source_json, defaults, generation_kinds, has_runtime,
    install_plans, provider_authenticated, remove_plans, required_storage_address, resolve,
    resource_label, validate, validate_provider, validate_route,
};

/// Run the package implementation encoded in `NEMOCLAW_RUNTIME_SPEC`.
///
/// The executable remains package-neutral; installer dispatch and behavior are
/// owned entirely by this service component.
#[cfg(target_os = "linux")]
pub async fn run_runtime(
    cancel: &crate::CancellationToken,
    trip: &crate::CancellationToken,
) -> Result<(), crate::Error> {
    runtime::run(cancel, trip).await
}
