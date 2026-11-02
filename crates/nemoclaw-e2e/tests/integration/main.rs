// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Integration tests against local fixtures only, linked into one binary:
//! fake engines, gateways, model servers, and Kubernetes APIs, never real
//! Docker, Kubernetes, images, or inference. Each file is a module; shared
//! helpers are declared once here.

#[path = "agent_compatibility.rs"]
mod agent_compatibility;
#[path = "deployment.rs"]
mod deployment;
#[cfg(unix)]
#[path = "../../../test-support/docker_engine.rs"]
mod docker_engine;
#[path = "docker_fixture.rs"]
mod docker_fixture;
#[path = "export_observations.rs"]
mod export_observations;
#[path = "fabric_bridge.rs"]
mod fabric_bridge;
#[path = "fabric_deployment.rs"]
mod fabric_deployment;
#[cfg(unix)]
#[path = "helm_recovery.rs"]
mod helm_recovery;
// Managed gateway storage takes only a local engine socket, which only Unix
// clients reach.
#[cfg(unix)]
#[path = "tofu_test/mod.rs"]
mod hcl_integration;
#[cfg(unix)]
#[path = "../../../test-support/kube_api.rs"]
mod kube_api;
#[path = "kubernetes_agents.rs"]
mod kubernetes_agents;
#[path = "multi_agent.rs"]
mod multi_agent;
#[path = "multiple_providers.rs"]
mod multiple_providers;
#[path = "openshell_contract_fixtures.rs"]
mod openshell_contract_fixtures;
#[path = "remote_service.rs"]
mod remote_service;
#[path = "tls.rs"]
mod tls;
#[path = "../../../test-support/http.rs"]
mod transport;
#[path = "travel_example.rs"]
mod travel_example;
mod travel_team_example;
#[path = "web_search.rs"]
mod web_search;
