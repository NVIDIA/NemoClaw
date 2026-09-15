// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod models;
pub use models::*;
mod service;
pub use service::{ProxySettings, Service, ServiceSpec};
mod backend;
pub(crate) mod proxy;
pub use backend::OllamaBackend;
