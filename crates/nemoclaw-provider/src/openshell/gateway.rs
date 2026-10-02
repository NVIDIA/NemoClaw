// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::OpenShell;
use nemoclaw_sdk::{Error, ObservationError, discovery::GatewayCapabilities};

impl OpenShell {
    pub async fn gateway_capabilities(&self) -> Result<GatewayCapabilities, ObservationError> {
        self.gateway.gateway_capabilities().await
    }

    pub async fn verify_gateway(
        &self,
        driver: nemoclaw_sdk::config::ComputeDriver,
    ) -> Result<(), Error> {
        self.gateway_capabilities().await?.require(driver)
    }
}
