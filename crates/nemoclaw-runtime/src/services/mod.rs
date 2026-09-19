// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Runtime entry point for installer-owned managed service processes.

mod installers;

use nemoclaw_sdk::{CancellationToken, Error};

pub(crate) async fn run(cancel: &CancellationToken, trip: &CancellationToken) -> Result<(), Error> {
    installers::run(cancel, trip).await
}
