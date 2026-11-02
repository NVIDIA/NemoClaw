// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Live end-to-end tests, linked into one binary: they use real Docker
//! engines, Kubernetes clusters, images, or inference, and stay ignored unless
//! selected. The offline checks of their helpers run with the unit tests. Each
//! file is a module; shared helpers are declared once here.

#[path = "cache_provider.rs"]
mod cache_provider;
#[path = "docker_provider_proxy.rs"]
mod docker_provider_proxy;
#[cfg(unix)]
#[path = "dummy_agent.rs"]
mod dummy_agent;
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
#[path = "pseudo_terminal.rs"]
mod pseudo_terminal;
mod registry_fixture;
#[path = "spark.rs"]
mod spark;

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
