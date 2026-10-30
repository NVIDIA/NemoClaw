// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! End-to-end fixture and opt-in live tests, linked into one binary.
//! Each file is a module; shared helpers are declared once here.

#[path = "agent_compatibility.rs"]
mod agent_compatibility;
#[path = "cache_provider.rs"]
mod cache_provider;
#[path = "deployment.rs"]
mod deployment;
#[cfg(unix)]
#[path = "../../test-support/docker_engine.rs"]
mod docker_engine;
#[path = "docker_fixture.rs"]
mod docker_fixture;
#[path = "docker_provider_proxy.rs"]
mod docker_provider_proxy;
#[cfg(unix)]
#[path = "dummy_agent.rs"]
mod dummy_agent;
#[path = "export_observations.rs"]
mod export_observations;
#[path = "fabric_bridge.rs"]
mod fabric_bridge;
#[path = "fabric_deployment.rs"]
mod fabric_deployment;
#[path = "fabric_live.rs"]
mod fabric_live;
// Unix only, as before it moved here from nemoclaw-sdk.
#[cfg(target_os = "linux")]
mod docker_registry;
#[path = "hcl_live.rs"]
mod hcl_live;
#[cfg(unix)]
#[path = "helm_recovery.rs"]
mod helm_recovery;
// Managed gateway storage takes only a local engine socket, which only Unix
// clients reach.
#[cfg(unix)]
#[path = "hcl_integration/mod.rs"]
mod hcl_integration;
#[path = "hosted_parity.rs"]
mod hosted_parity;
#[cfg(unix)]
#[path = "../../test-support/kube_api.rs"]
mod kube_api;
#[path = "kubernetes_agents.rs"]
mod kubernetes_agents;
#[path = "kubernetes_chart.rs"]
mod kubernetes_chart;
#[path = "kubernetes_live.rs"]
mod kubernetes_live;
#[path = "managed.rs"]
mod managed;
#[cfg(unix)]
#[path = "managed_gateway.rs"]
mod managed_gateway;
#[path = "model_live.rs"]
mod model_live;
#[path = "multi_agent.rs"]
mod multi_agent;
#[path = "multiple_providers.rs"]
mod multiple_providers;
#[path = "openshell_contract_fixtures.rs"]
mod openshell_contract_fixtures;
mod registry_fixture;
#[path = "remote_service.rs"]
mod remote_service;
#[path = "spark.rs"]
mod spark;
#[path = "tls.rs"]
mod tls;
#[path = "../../test-support/http.rs"]
mod transport;
#[path = "travel_example.rs"]
mod travel_example;
mod travel_team_example;
#[path = "web_search.rs"]
mod web_search;

#[cfg(target_os = "linux")]
mod existing_ollama;
#[cfg(target_os = "linux")]
mod managed_ollama;
#[cfg(target_os = "linux")]
mod remote_models;
#[cfg(target_os = "linux")]
mod service_images;
#[cfg(target_os = "linux")]
mod shared_service;
