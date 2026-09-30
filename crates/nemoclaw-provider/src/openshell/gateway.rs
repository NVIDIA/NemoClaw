// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{OpenShell, proto, remote_error};
use nemoclaw_sdk::{Error, ObservationError, discovery::GatewayCapabilities};
use std::time::Duration;

impl OpenShell {
    /// Read version and driver metadata through the configured authenticated channel.
    /// A failed or incomplete observation is never an absent gateway.
    pub async fn gateway_capabilities(&self) -> Result<GatewayCapabilities, ObservationError> {
        let response = tokio::time::timeout(Duration::from_secs(30), async {
            self.client
                .raw_grpc()
                .get_gateway_info(self.request(proto::GetGatewayInfoRequest {}))
                .await
        })
        .await
        .map_err(|_| ObservationError::Transport)?
        .map_err(|error| remote_error(&error))?;
        response.into_inner().try_into()
    }

    pub async fn verify_gateway(
        &self,
        driver: nemoclaw_sdk::config::ComputeDriver,
    ) -> Result<(), Error> {
        self.gateway_capabilities().await?.require(driver)
    }
}
