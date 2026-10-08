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

/// Identity that must survive refresh, independently of configuration drift.
pub use nemoclaw_backend::{Binding, Bound, Observation, ObservationError, refresh};

pub mod backend;
pub mod compile;
pub mod config;
pub use nemoclaw_backend::{EnvironmentSecrets, Secrets};
pub use nemoclaw_backend::{RuntimeHealth, SandboxHealth};
pub use nemoclaw_tofu::shape as hcl_schema;
mod gateway_observation;
#[doc(hidden)]
pub mod services;
mod state;
pub use nemoclaw_backend::Error;
pub mod bundle;
mod process;
pub use tokio_util::sync::CancellationToken;
mod deployment;
pub use deployment::{
    Change, Deployment, DeploymentConnection, DiscoveryObservation, DiscoveryReport,
    DiscoveryScope, DiscoveryTarget, OperationResult, Outcome, PlanObservation, Progress,
    ReportedObservation, ResourceInventoryEntry, ResourceSource, StepOutcome,
};

pub mod managed;

pub mod kubernetes;

pub mod hardware_discovery;

mod tofu_ui;

mod download;
pub use download::{ByteProgress, DownloadPhase, DownloadProgress};

mod docker_compute;

/// What a deployment needs to know about its target, and what each read reports.
pub mod discovery;

mod discovery_graph;

/// Read-only inference metadata and direct credential availability.
pub mod inference_discovery;
