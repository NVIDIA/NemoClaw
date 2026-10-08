// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_runtime::ollama::models::*;
pub use nemoclaw_sdk::{
    services::installers::ollama::ProxySettings, services::installers::ollama::ProxySpec,
    services::installers::ollama::SERVICE_KIND, services::installers::ollama::STORAGE_KIND,
    services::installers::ollama::configured_service,
};
use nemoclaw_sdk::{
    services::installers::ollama::proxy::MODEL, services::installers::ollama::proxy::STORAGE,
    services::installers::ollama::proxy::supports,
};
mod backend;
pub use backend::ProxyBackend;
mod runtime;
pub use runtime::ProxyRuntimeDataSource;
pub(crate) mod proxy;
#[cfg(all(test, unix))]
mod proxy_container_tests;
