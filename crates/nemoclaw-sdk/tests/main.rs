// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! SDK integration tests, linked into one binary so the SDK links once.
//! Each file is a module; helpers under support/ are shared by all of them.

#[path = "support/examples.rs"]
mod examples;
#[path = "support/provider_scope.rs"]
mod provider_scope;
#[path = "support/config.rs"]
mod support;
#[path = "../../test-support/http.rs"]
mod transport;

#[path = "agent_tools.rs"]
mod agent_tools;
#[path = "compile.rs"]
mod compile;
#[path = "config.rs"]
mod config;
#[path = "config_choices.rs"]
mod config_choices;
#[path = "config_diagnostics.rs"]
mod config_diagnostics;
#[path = "config_input.rs"]
mod config_input;
#[path = "config_kinds.rs"]
mod config_kinds;
#[path = "config_kubernetes.rs"]
mod config_kubernetes;
#[path = "config_openshift.rs"]
mod config_openshift;
#[path = "config_scenarios.rs"]
mod config_scenarios;
#[path = "config_schema.rs"]
mod config_schema;
#[path = "config_validation.rs"]
mod config_validation;
#[path = "deployment.rs"]
mod deployment;
#[path = "discovery.rs"]
mod discovery;
#[path = "engine_endpoint.rs"]
mod engine_endpoint;
#[path = "error.rs"]
mod error;
#[path = "execution_settings.rs"]
mod execution_settings;
#[path = "explicit_hardware.rs"]
mod explicit_hardware;
#[path = "fabric_capabilities.rs"]
mod fabric_capabilities;
#[path = "fabric_planner.rs"]
mod fabric_planner;
#[path = "gpu_inventory.rs"]
mod gpu_inventory;
#[path = "hardware_discovery.rs"]
mod hardware_discovery;
#[path = "hardware_profiles.rs"]
mod hardware_profiles;
#[path = "harness_references.rs"]
mod harness_references;
#[path = "inference_connection.rs"]
mod inference_connection;
#[path = "inference_discovery.rs"]
mod inference_discovery;
#[path = "inference_references.rs"]
mod inference_references;
#[path = "inference_settings.rs"]
mod inference_settings;
#[path = "inline_recipe.rs"]
mod inline_recipe;
#[path = "interfaces.rs"]
mod interfaces;
#[path = "kubernetes_cluster.rs"]
mod kubernetes_cluster;
#[path = "kubernetes_compile.rs"]
mod kubernetes_compile;
#[path = "kubernetes_connection.rs"]
mod kubernetes_connection;
#[path = "kubernetes_managed_compile.rs"]
mod kubernetes_managed_compile;
#[path = "kubernetes_receipt.rs"]
mod kubernetes_receipt;
#[path = "managed_auth.rs"]
mod managed_auth;
#[path = "managed_hermes.rs"]
mod managed_hermes;
#[path = "managed_live.rs"]
mod managed_live;
#[path = "managed_podman.rs"]
mod managed_podman;
#[path = "model_selection.rs"]
mod model_selection;
#[path = "multiple_models.rs"]
mod multiple_models;
#[path = "multiple_providers.rs"]
mod multiple_providers;
#[path = "multiple_sandboxes.rs"]
mod multiple_sandboxes;
#[path = "mutation.rs"]
mod mutation;
#[path = "native_inference.rs"]
mod native_inference;
#[path = "nemotron_serving.rs"]
mod nemotron_serving;
#[path = "network_config.rs"]
mod network_config;
#[path = "observability.rs"]
mod observability;
#[path = "ollama_proxy.rs"]
mod ollama_proxy;
#[path = "provider_references.rs"]
mod provider_references;
#[path = "reference_combinations.rs"]
mod reference_combinations;
#[path = "reference_diagnostics.rs"]
mod reference_diagnostics;
#[path = "refresh.rs"]
mod refresh;
#[path = "resource_management.rs"]
mod resource_management;
#[path = "runtime_boundaries.rs"]
mod runtime_boundaries;
#[path = "runtime_compile.rs"]
mod runtime_compile;
#[path = "service_references.rs"]
mod service_references;
#[path = "spark_examples.rs"]
mod spark_examples;
#[path = "ssh_live.rs"]
mod ssh_live;
#[path = "telemetry.rs"]
mod telemetry;
#[path = "web_search.rs"]
mod web_search;
