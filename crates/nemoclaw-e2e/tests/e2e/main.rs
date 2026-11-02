// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Live end-to-end tests, linked into one binary: they use real Docker
//! engines, Kubernetes clusters, images, or inference, and stay ignored unless
//! selected. The offline checks of their helpers run with the unit tests.
//!
//! `hcl_live` runs the HCL E2E scenarios in `hcl/`, each a successful path
//! through one document in the crate's `cases/`. The modules under `rust/`
//! are live tests not yet migrated to those scenarios. Module names do not
//! include the directory, so test names and profile filters stay stable.

#[path = "hcl_live.rs"]
mod hcl_live;
#[path = "hosted_parity.rs"]
mod hosted_parity;

#[path = "rust/cache_provider.rs"]
mod cache_provider;
#[path = "rust/docker_provider_proxy.rs"]
mod docker_provider_proxy;
#[cfg(unix)]
// Unix only, as before it moved here from nemoclaw-sdk.
#[cfg(target_os = "linux")]
#[path = "rust/docker_registry.rs"]
mod docker_registry;
#[path = "rust/interfaces_live.rs"]
mod interfaces_live;
#[path = "rust/kubernetes_chart.rs"]
mod kubernetes_chart;
#[path = "rust/kubernetes_live.rs"]
mod kubernetes_live;
#[path = "rust/managed.rs"]
mod managed;
#[cfg(unix)]
#[path = "rust/managed_gateway.rs"]
mod managed_gateway;
#[path = "rust/pseudo_terminal.rs"]
mod pseudo_terminal;
#[path = "rust/registry_fixture.rs"]
mod registry_fixture;
#[path = "rust/spark.rs"]
mod spark;

#[cfg(target_os = "linux")]
#[path = "rust/existing_ollama.rs"]
mod existing_ollama;
#[cfg(target_os = "linux")]
#[path = "rust/managed_ollama.rs"]
mod managed_ollama;
#[cfg(target_os = "linux")]
#[path = "rust/remote_models.rs"]
mod remote_models;
#[cfg(target_os = "linux")]
#[path = "rust/service_images/mod.rs"]
mod service_images;
#[cfg(target_os = "linux")]
#[path = "rust/shared_service.rs"]
mod shared_service;
