// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{
    config::ImagePullPolicy,
    services::placement::{ServicePlacement, ServicePublication},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// An operator-owned regular file on the Docker engine host. NemoClaw never copies its contents into configuration or state.
pub struct NgcCredential {
    /// Absolute file path. Rotate by selecting a versioned path and explicitly recreating the service; the operator retains and removes the file.
    #[schemars(length(min = 2, max = 4096))]
    pub file: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Native NIM with a vLLM backend, isolated behind a route-filter container.
pub struct Nim {
    /// Preserve refuses model replacement; Recreate permits sequential replacement and downtime during explicit apply.
    #[serde(
        default,
        skip_serializing_if = "crate::services::ServiceUpdatePolicy::is_preserve"
    )]
    pub update_policy: crate::services::ServiceUpdatePolicy,
    /// Docker execution limits and GPU selection, separate from native memory protection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<super::super::container::ServiceContainer>,
    /// Digest-pinned native NIM image containing the NemoClaw supervisor and nginx.
    pub image: String,
    /// IfNotPresent acquires a missing image; Never requires a locally installed image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_pull_policy: Option<ImagePullPolicy>,
    /// Explicit SSH Docker placement; pair with publication. Omission inherits a managed local Docker gateway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<ServicePlacement>,
    /// Private published inference address reachable by OpenShell; pair with placement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication: Option<ServicePublication>,
    /// Dedicated canonical private IPv4 /24, distinct from all other service and gateway networks on this engine.
    #[serde(rename = "backendNetworkCIDR")]
    pub backend_network_cidr: String,
    /// Operator-owned NGC credential file on the selected Docker host, mounted read-only for native startup.
    pub ngc_credential: NgcCredential,
    #[serde(flatten)]
    pub runtime: nemoclaw_runtime::nim::NimService,
}

impl std::ops::Deref for Nim {
    type Target = nemoclaw_runtime::nim::NimService;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}
impl std::ops::DerefMut for Nim {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.runtime
    }
}
