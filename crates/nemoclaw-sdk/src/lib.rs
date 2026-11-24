// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Programmatic desired-state contracts shared by NemoClaw consumers.
//!
//! Backend mutation belongs to the provider, outside the SDK API:
//!
//! ```compile_fail
//! use nemoclaw_sdk::openshell::OpenShell;
//! let _ = OpenShell::connect;
//! ```
//!
//! Download callbacks are delivered through deployment progress:
//!
//! ```compile_fail
//! use nemoclaw_sdk::with_download_progress;
//! ```
//!
//! Engine operations are implemented by the bundled provider:
//!
//! ```compile_fail
//! use nemoclaw_sdk::docker::Engine;
//! ```

pub mod fabric_capabilities;
pub use nemoclaw_fabric::catalog as fabric_catalog;
pub mod fabric_config;
pub use nemoclaw_fabric::image_metadata;
pub mod image_runtime;
pub mod json_schema;

mod artifact_pins {
    include!(concat!(env!("OUT_DIR"), "/artifact_pins.rs"));
}

/// The host OpenShell client version qualified with this NemoClaw build.
/// This is separate from observing a gateway's version and compute driver.
pub const OPENSHELL_CLIENT_VERSION: &str = artifact_pins::OPENSHELL_VERSION;

/// Identity that must survive refresh, independently of configuration drift.
pub use nemoclaw_backend::{Binding, Bound, Observation, ObservationError, refresh};

pub mod backend;
pub mod compile;
pub mod config;

/// A reachable guide at this build's source revision. Git-less builds without
/// recorded provenance direct the reader to their original source instead.
pub fn documentation_url(path: &str) -> String {
    let revision = env!("NEMOCLAW_DOCS_REVISION");
    if revision.is_empty() {
        format!("{path} in this build's original source (documentation revision unavailable)")
    } else {
        format!("https://github.com/NVIDIA/NemoClaw/blob/{revision}/{path}")
    }
}
pub use nemoclaw_backend::{EnvironmentSecrets, Secrets};
pub use nemoclaw_tofu::shape as hcl_schema;
mod gateway_observation;
#[doc(hidden)]
pub mod services;
mod state;
pub use nemoclaw_backend::Error;
pub mod bundle;
#[cfg(all(test, unix))]
#[path = "../../test-support/executable.rs"]
mod executable;
mod process;
pub use tokio_util::sync::CancellationToken;
mod deployment;
pub use deployment::{
    AgentRuntime, Change, Deployment, DeploymentConnection, DiscoveryObservation, DiscoveryReport,
    DiscoveryScope, DiscoveryTarget, InterfaceAccess, OperationResult, Outcome, PlanObservation,
    Progress, ReportedObservation, ResourceInventoryEntry, ResourceSource, SignIn, StepOutcome,
};

pub mod managed;
pub mod telemetry;

pub mod kubernetes;

pub mod hardware_discovery;

mod tofu_ui;

mod download;
pub use download::{ByteProgress, DownloadPhase, DownloadProgress};

mod docker_compute;

/// What a deployment needs to know about its target, and what each read reports.
pub mod discovery;

mod discovery_graph;

mod inference_catalog;
/// Read-only inference metadata and direct credential availability.
pub mod inference_discovery;
