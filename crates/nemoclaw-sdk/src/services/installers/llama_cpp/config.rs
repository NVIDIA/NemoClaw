// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::ServiceContainer;
use crate::config::ImagePullPolicy;
use crate::services::placement::{ServicePlacement, ServicePublication};

use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Managed llama.cpp service. Explicit placement and publication must appear together.
pub struct LlamaCpp {
    /// Preserve refuses replacement of a running Docker model container. Recreate permits sequential replacement and possible downtime until removed or changed.
    #[serde(
        rename = "updatePolicy",
        default,
        skip_serializing_if = "crate::services::ServiceUpdatePolicy::is_preserve"
    )]
    pub update_policy: crate::services::ServiceUpdatePolicy,
    /// Container CPU and memory limits, GPU selection, IPC, and shared memory for Docker. Native managed Podman inference is unsupported. Omission uses private IPC and 8 GiB of shared memory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServiceContainer")]
    pub container: Option<ServiceContainer>,
    /// Immutable image containing llama-server and the NemoClaw supervisor.
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
    pub runtime: nemoclaw_runtime::llama_cpp::LlamaCppService,
}

impl std::ops::Deref for LlamaCpp {
    type Target = nemoclaw_runtime::llama_cpp::LlamaCppService;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}
impl std::ops::DerefMut for LlamaCpp {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.runtime
    }
}
