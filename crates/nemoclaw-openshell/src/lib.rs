// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! OpenShell rules shared by the SDK compiler and the providers: gateway
//! connections and capabilities, compute drivers, and object lifecycles.

mod capabilities;
mod connection;
pub mod credential_metadata;
mod driver;
mod inputs;
mod lifecycle;
mod names;
mod observation;
pub mod pairs;
pub mod policy;
pub mod profile;
pub mod runtime;
pub mod search;
mod wait;

pub use capabilities::{GatewayCapabilities, OPENSHELL_VERSION};
pub use connection::{
    Connection, RejectableOperation, TlsFiles, capabilities, client, health, remote_error,
    remote_rejection, request,
};
pub use driver::ComputeDriver;
pub use inputs::{
    GATEWAY_FIELDS, GATEWAY_TYPE, INFERENCE_SERVER_TYPE, export, flatten, gateway_reference,
    references, structured_inputs, without_gateway,
};
pub use lifecycle::{
    INSTALLATION_TYPES, OpenShellLifecycle, PROVIDER_TYPE, RESOURCE_TYPES, installation_type,
    object_kind, openshell_lifecycle, ref_type, registration_name, resource_type, type_name,
};
pub use names::{NAME_PATTERN, valid_name};
pub use observation::GatewayObservation;
pub use wait::observe_with_wait;
