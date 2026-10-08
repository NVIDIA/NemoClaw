// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! OpenShell rules shared by the SDK compiler and the providers: gateway
//! connections and capabilities, compute drivers, and object lifecycles.

mod capabilities;
mod connection;
pub mod credential_metadata;
mod driver;
mod lifecycle;
mod names;
pub mod policy;
pub mod profile;
pub mod runtime;
pub mod search;

pub use capabilities::{GatewayCapabilities, OPENSHELL_VERSION};
pub use connection::{Connection, TlsFiles, capabilities, client, health, remote_error, request};
pub use driver::ComputeDriver;
pub use lifecycle::{OpenShellLifecycle, openshell_lifecycle};
pub use names::{NAME_PATTERN, valid_name};
