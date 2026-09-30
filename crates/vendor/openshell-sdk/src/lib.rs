// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Shared async Rust client for `OpenShell` gateways.
//!
//! Two layers:
//!
//! - [`OpenShellClient`] — the high-level sandbox-focused MVP surface:
//!   health, sandbox CRUD, reusable sandbox templates, readiness/deletion
//!   waits, and non-streaming exec.
//! - [`raw`] — direct access to the generated tonic clients for RPCs the
//!   curated surface doesn't yet cover (providers, policy, logs, settings,
//!   SSH, forwarding).
//!
//! Owns the gRPC transport stack — channel construction, TLS material
//! handling, request interceptors, OIDC token refresh, and the Cloudflare
//! Access tunnel proxy. Consumed by `openshell-cli`, `openshell-tui`, and
//! the napi-rs wrapper that ships as `@openshell/sdk`.
//!
//! # Quick start
//!
//! ```ignore
//! use openshell_sdk::{ClientConfig, ListOptions, OpenShellClient};
//!
//! # async fn run() -> Result<(), openshell_sdk::SdkError> {
//! let client = OpenShellClient::connect(ClientConfig::new("http://127.0.0.1:8080")).await?;
//! let health = client.health().await?;
//! let sandboxes = client.list_all_sandboxes(ListOptions::default()).await?;
//! # Ok(())
//! # }
//! ```

pub mod auth;
pub mod client;
pub mod config;
pub mod edge_tunnel;
pub mod error;
pub mod oidc;
pub mod pagination;
pub mod provider_readiness;
pub mod raw;
pub mod refresh;
pub mod transport;
pub mod types;

pub use auth::EdgeAuthInterceptor;
pub use client::{OpenShellClient, WorkspaceScopedClient};
pub use config::{AuthConfig, ClientConfig};
pub use error::SdkError;
pub use pagination::{Page, Pager};
pub use refresh::{Refresh, RefreshError, RefreshedToken, TokenSource};
pub use types::{
    DeleteOptions, DeletionOutcome, DeletionResult, ExecOptions, ExecResult, Health, ListOptions,
    LogLine, PlatformEvent, SandboxPhase, SandboxRef, SandboxResources, SandboxServiceLevel,
    SandboxSpec, SandboxStartup, SandboxTemplateCreateSpec, SandboxTemplateListOptions,
    SandboxWorkloadConfig, SandboxWorkloadTemplate, SandboxWorkloadTemplateProvenance,
    SandboxWorkloadTemplateSpec, ServiceExposure, ServiceStatus, WatchEvent, WatchOptions,
    WorkspaceRef,
};
