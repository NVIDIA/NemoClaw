// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Managed package installers selected by `spec.services`.
//!
//! The deployment core consumes package-independent install plans. Consumer
//! bindings, package dispatch, readiness checks, and destroy policy remain here.

pub(crate) mod authentication;
mod contract;
pub mod installers;
mod registry;

pub(crate) use contract::InstallStage;
pub use contract::ServiceRuntime;
pub use installers::ollama::{
    ExternalOllama, ExternalOllamaModel, ManagedOllama, OllamaModel, OllamaProxy,
};
pub(crate) use registry::InstallPlans;
pub use registry::{
    BackendRegistry, RegisteredBackend, ResourceBehavior, ResourceSchema, ServiceDefinition,
    resource_behavior, resource_schemas,
};
pub(crate) use registry::{
    check_combined_capacity, check_running, check_runtime_capacity, constrain_schema,
    credential_source_json, defaults, generation_kinds, has_runtime, install_plans,
    provider_authenticated, remove_plans, required_storage_address, resolve, resource_label,
    validate, validate_provider, validate_route,
};
