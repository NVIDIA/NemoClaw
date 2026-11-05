// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
pub mod gateway_config;
mod spec;
pub use nemoclaw_docker::Storage;
pub use spec::*;
pub const GATEWAY_STORAGE_KIND: &str = "gateway_storage";
