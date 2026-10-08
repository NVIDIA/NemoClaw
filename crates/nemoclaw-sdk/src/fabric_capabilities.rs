// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Fabric capability assessment, with the requirements a sandbox's YAML
//! document places on its image.
pub use nemoclaw_fabric::capabilities::*;

/// The Fabric configuration and filesystem reads a sandbox requires.
pub fn requirements_for_sandbox(
    document: &crate::config::Document,
    sandbox: &crate::config::Sandbox,
) -> Result<FabricRequirements, crate::config::ConfigError> {
    let filesystem_read = match &sandbox.network.policy {
        crate::config::NetworkPolicy::Explicit(policy) => {
            policy.filesystem_policy.as_ref().map(|fs| {
                fs.read_only
                    .iter()
                    .flatten()
                    .chain(fs.read_write.iter().flatten())
                    .cloned()
                    .collect()
            })
        }
        _ => None,
    };
    Ok(FabricRequirements {
        configuration: crate::fabric_config::for_sandbox(document, sandbox)?,
        filesystem_read,
    })
}
