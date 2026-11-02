// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Integration tests: the SDK, the CLI, and a bundle's OpenTofu and providers
//! against local fixtures, without Docker workloads, a cluster, or inference.
//!
//! - `hcl/` holds the `tofu test` scenarios, the main format; `tofu_test/`
//!   is their runner, the `hcl_integration` module.
//! - `failure_cases/` holds the Rust tests for what `tofu test` cannot
//!   express: provider errors and the SDK's recovery from them, saved state
//!   and intent, export, interrupted operations, and CLI output.
//! - The other files are offline checks of the fixtures and clients these
//!   tests use, and run with the unit tests.
//!
//! Module paths keep each file's module name, so test names do not depend on
//! the directory. Shared helpers are declared once here.

#[path = "agent_compatibility.rs"]
mod agent_compatibility;
#[path = "failure_cases/deployment.rs"]
mod deployment;
#[path = "../../../test-support/docker_engine.rs"]
mod docker_engine;
#[path = "docker_fixture.rs"]
mod docker_fixture;
#[path = "failure_cases/export_observations.rs"]
mod export_observations;
#[path = "fabric_bridge.rs"]
mod fabric_bridge;
#[path = "failure_cases/fabric_deployment.rs"]
mod fabric_deployment;
// Scenarios with managed Docker gateway storage, which takes only a local
// engine socket, run only on Unix; the runner skips them elsewhere.
#[path = "tofu_test/mod.rs"]
mod hcl_integration;
#[cfg(unix)]
#[path = "failure_cases/helm_recovery.rs"]
mod helm_recovery;
#[cfg(unix)]
#[path = "../../../test-support/kube_api.rs"]
mod kube_api;
#[path = "failure_cases/multi_agent.rs"]
mod multi_agent;
#[path = "openshell_contract_fixtures.rs"]
mod openshell_contract_fixtures;
#[path = "failure_cases/remote_service.rs"]
mod remote_service;
#[path = "tls.rs"]
mod tls;
#[path = "../../../test-support/http.rs"]
mod transport;
#[path = "web_search.rs"]
mod web_search;
