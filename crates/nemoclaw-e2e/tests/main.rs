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
#[path = "discovery.rs"]
mod discovery;
#[path = "docker_fixture.rs"]
mod docker_fixture;
#[path = "docker_provider_proxy.rs"]
mod docker_provider_proxy;
#[path = "export_observations.rs"]
mod export_observations;
#[path = "fabric_deployment.rs"]
mod fabric_deployment;
#[path = "fabric_live.rs"]
mod fabric_live;
#[path = "gateway_readiness.rs"]
mod gateway_readiness;
#[path = "health.rs"]
mod health;
#[path = "hosted_parity.rs"]
mod hosted_parity;
#[path = "inference_discovery.rs"]
mod inference_discovery;
#[path = "managed.rs"]
mod managed;
#[path = "model_live.rs"]
mod model_live;
#[path = "multiple_providers.rs"]
mod multiple_providers;
#[path = "openshell.rs"]
mod openshell;
#[path = "opentofu_openshell.rs"]
mod opentofu_openshell;
#[path = "provider_protocol.rs"]
mod provider_protocol;
#[path = "remote_service.rs"]
mod remote_service;
#[path = "sandbox_readiness.rs"]
mod sandbox_readiness;
#[path = "service_capacity.rs"]
mod service_capacity;
#[path = "service_readiness.rs"]
mod service_readiness;
#[path = "spark.rs"]
mod spark;
#[path = "tls.rs"]
mod tls;
#[path = "web_search.rs"]
mod web_search;
