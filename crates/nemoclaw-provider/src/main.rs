// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The HTTP client also enables aws-lc. Select the plugin transport backend
    // before OpenTofu requests automatic mTLS; feature unification is ambiguous.
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| "provider TLS initialization failed")?;
    tf_provider::serve("nemoclaw", nemoclaw_provider::NemoClawProvider::default()).await?;
    Ok(())
}
