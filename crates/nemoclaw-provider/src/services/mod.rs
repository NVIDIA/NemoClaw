// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
pub mod authentication;
mod registry;
pub use registry::BackendRegistry;
pub(crate) mod capacity;
pub use capacity::{ServiceCapacity, observe_service_capacity, validate_capacity_specs};
mod readiness;
pub use readiness::{validate_readiness_spec, wait_service_ready};
pub mod installers;
use nemoclaw_sdk::services::validate_resource_spec;
