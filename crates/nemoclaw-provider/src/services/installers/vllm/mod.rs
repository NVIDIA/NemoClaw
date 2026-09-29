// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_runtime::vllm::{hardware_capacity, recipes};
pub use nemoclaw_sdk::{
    services::installers::vllm::SERVICE_KIND, services::installers::vllm::STORAGE_KIND,
    services::installers::vllm::configured_service,
};
mod artifacts;
pub use artifacts::RuntimeStatus;
mod capacity;
