// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod authentication;
mod hardware;
mod inline_recipe;
mod process;
mod recipe;
mod runtime;

use nemoclaw_sdk::{CancellationToken, Error, services::installers::vllm::Service};

pub(super) async fn run(
    spec: &Service,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    runtime::run(spec, cancel, trip).await
}
