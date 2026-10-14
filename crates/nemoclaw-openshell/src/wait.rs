// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Waiting for a gateway that is still starting.

use nemoclaw_backend::ObservationError;
use std::{future::Future, time::Duration};

/// Retry transport failures until `timeout`; any other failure ends the wait.
pub async fn observe_with_wait<T, F: Future<Output = Result<T, ObservationError>>>(
    timeout: Duration,
    mut observe: impl FnMut() -> F,
) -> Result<T, ObservationError> {
    if timeout.is_zero() {
        return observe().await;
    }
    tokio::time::timeout(timeout, async {
        loop {
            match observe().await {
                Err(ObservationError::Transport) => {
                    tokio::time::sleep(Duration::from_millis(200)).await
                }
                result => return result,
            }
        }
    })
    .await
    .unwrap_or(Err(ObservationError::Transport))
}
