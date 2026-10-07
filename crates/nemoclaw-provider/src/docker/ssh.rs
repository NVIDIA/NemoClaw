// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::Engine;
use crate::Error;

/// An SSH engine's host is never measured from this client.
pub(super) struct RemoteHost;
#[async_trait::async_trait]
impl crate::hardware::HostObserver for RemoteHost {
    async fn observe(&self, _: &Engine) -> Result<crate::hardware::HostObservation, Error> {
        Err(Error::Conflict(
            "remote host capacity requires an explicit observer",
        ))
    }
}
