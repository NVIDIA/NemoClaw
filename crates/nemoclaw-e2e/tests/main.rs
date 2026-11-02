// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Live end-to-end tests, opt-in through `#[ignore]`, against real Docker,
//! Kubernetes, images, and inference, with the offline checks of the fixtures
//! and clients they use. The system tests against local fixtures are the
//! `system` binary's. Each file is a module; shared helpers are declared once
//! here.

#[path = "agent_compatibility.rs"]
mod agent_compatibility;
#[path = "cache_provider.rs"]
mod cache_provider;
#[path = "docker_fixture.rs"]
mod docker_fixture;
#[path = "docker_provider_proxy.rs"]
mod docker_provider_proxy;
#[cfg(unix)]
#[path = "dummy_agent.rs"]
mod dummy_agent;
#[path = "fabric_bridge.rs"]
mod fabric_bridge;
#[path = "fabric_live.rs"]
mod fabric_live;
// Unix only, as before it moved here from nemoclaw-sdk.
#[cfg(target_os = "linux")]
mod docker_registry;
#[path = "hcl_live.rs"]
mod hcl_live;
#[path = "hosted_parity.rs"]
mod hosted_parity;
#[path = "interfaces_live.rs"]
mod interfaces_live;
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
#[path = "openshell_contract_fixtures.rs"]
mod openshell_contract_fixtures;
#[path = "pseudo_terminal.rs"]
mod pseudo_terminal;
mod registry_fixture;
#[path = "spark.rs"]
mod spark;
#[path = "tls.rs"]
mod tls;
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
