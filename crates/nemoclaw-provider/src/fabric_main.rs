// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The bundled Fabric provider includes NemoClaw's managed cluster checks.
//! Adapted from fabric-provider/src/main.rs at 13c51d5c to supply those callbacks.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Select the plugin transport backend before OpenTofu requests automatic mTLS.
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| "provider TLS initialization failed")?;
    tf_provider::serve(
        "fabric",
        fabric_provider::FabricProvider::with_services(std::sync::Arc::new(
            nemoclaw_provider::cluster_services::OpenShellServices,
        )),
    )
    .await?;
    Ok(())
}
