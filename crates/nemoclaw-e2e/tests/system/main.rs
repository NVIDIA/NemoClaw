// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! System tests: the SDK, the CLI, and a bundle's OpenTofu and providers
//! against local fixtures, without Docker workloads, a cluster, or inference.
//! `hcl_integration` runs SDK-compiled documents and authored examples under
//! `tofu test`; the other modules keep the SDK and CLI behavior that
//! `tofu test` cannot observe. The live end-to-end suites are the `e2e`
//! binary's. Each file is a module; shared helpers are declared once here.

#[path = "deployment.rs"]
mod deployment;
#[path = "../../../test-support/docker_engine.rs"]
mod docker_engine;
#[path = "export_observations.rs"]
mod export_observations;
#[path = "fabric_deployment.rs"]
mod fabric_deployment;
// Scenarios with managed Docker gateway storage, which takes only a local
// engine socket, run only on Unix; the runner skips them elsewhere.
#[path = "hcl_integration/mod.rs"]
mod hcl_integration;
#[cfg(unix)]
#[path = "helm_recovery.rs"]
mod helm_recovery;
#[cfg(unix)]
#[path = "../../../test-support/kube_api.rs"]
mod kube_api;
#[path = "multi_agent.rs"]
mod multi_agent;
#[path = "remote_service.rs"]
mod remote_service;
#[cfg(unix)]
#[path = "../../../test-support/http.rs"]
mod transport;
