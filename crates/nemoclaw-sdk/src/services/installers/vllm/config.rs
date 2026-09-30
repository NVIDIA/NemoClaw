// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::ServiceContainer;
use crate::config::ImagePullPolicy;
use crate::services::placement::{ServicePlacement, ServicePublication};
pub use nemoclaw_runtime::vllm::{Memory, Model, ServiceAuthentication, Serving};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Managed vLLM service. Explicit placement and publication must appear together.
pub struct Service {
    /// Optional managed container IPC and shared-memory settings. Omission uses private IPC and 8 GiB of shared memory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServiceContainer")]
    pub container: Option<ServiceContainer>,
    /// Immutable runtime image containing vLLM, the NemoClaw supervisor, and any declared recipe tools.
    pub image: String,
    /// Image acquisition before container creation. Omission means IfNotPresent.
    #[serde(
        rename = "imagePullPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "ImagePullPolicy")]
    pub image_pull_policy: Option<ImagePullPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ServicePlacement")]
    /// SSH Docker placement. Required with an external gateway or Podman sandbox; requires publication.
    #[schemars(extend("x-nemoclaw-required" = "With external gateway or Podman; paired with publication"))]
    pub placement: Option<ServicePlacement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ServicePublication")]
    /// Private inference address reachable by OpenShell. Required with placement.
    #[schemars(extend("x-nemoclaw-required" = "With placement"))]
    pub publication: Option<ServicePublication>,
    #[serde(flatten)]
    pub runtime: nemoclaw_runtime::vllm::Service,
}

impl std::ops::Deref for Service {
    type Target = nemoclaw_runtime::vllm::Service;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}
impl std::ops::DerefMut for Service {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.runtime
    }
}
impl Service {
    pub(crate) fn runtime_settings(&self) -> nemoclaw_runtime::vllm::Service {
        self.runtime.clone()
    }
}
