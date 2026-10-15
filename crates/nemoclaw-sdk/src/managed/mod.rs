// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod settings;
mod spec;
pub use nemoclaw_docker::Storage;
pub use settings::GatewaySettings;
pub use spec::*;
pub const GATEWAY_STORAGE_KIND: &str = "gateway_storage";
