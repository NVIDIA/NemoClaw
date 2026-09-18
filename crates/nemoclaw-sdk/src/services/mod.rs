// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Managed package installers selected by `spec.services`.
//!
//! The deployment core consumes install plans and resolved inference settings.
//! Package dispatch, readiness checks, and destroy policy remain here.

pub(crate) mod authentication;
mod contract;
pub(crate) mod installers;
mod registry;

pub(crate) use contract::InstallStage;
pub use contract::ServiceRuntime;
pub use installers::ollama::{
    ExternalOllama, ExternalOllamaModel, ManagedOllama, OllamaModel, OllamaProxy,
};
pub use registry::{
    BackendRegistry, RegisteredBackend, ResourceBehavior, ResourceSchema, ServiceDefinition,
    resource_behavior, resource_schemas,
};
pub(crate) use registry::{
    check_combined_capacity, check_running, check_runtime_capacity, credential_source_json,
    defaults, dependencies, deployment_targets, generation_kinds, has_runtime,
    provider_authenticated, remove_plans, required_storage_address, resolve, runtime_targets,
    validate, validate_provider, validate_route,
};
