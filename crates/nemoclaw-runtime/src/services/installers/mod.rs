// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod vllm;

use nemoclaw_sdk::{CancellationToken, Error};

pub(super) async fn run(cancel: &CancellationToken, trip: &CancellationToken) -> Result<(), Error> {
    vllm::run(cancel, trip).await
}
