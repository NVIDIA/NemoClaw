// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod hardware;
mod observation;
mod process;
mod recipe;
mod runtime;

use nemoclaw_sdk::{CancellationToken, Error, services::installers::ollama::ManagedOllama};

pub(super) async fn run(
    service: &ManagedOllama,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    runtime::run(service, cancel, trip).await
}
