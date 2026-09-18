// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Package-independent service installer input and output.

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

static IMAGE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(crate::config::constraints::IMAGE).unwrap());

pub(super) fn validate_runtime(runtime: &ServiceRuntime) -> Result<(), crate::config::ConfigError> {
    crate::config::validation::require(
        runtime.provider == "docker"
            && !runtime
                .engine
                .contains(['$', '%', '{', '}', '\r', '\n', '\0'])
            && crate::docker::Engine::validate_endpoint(&runtime.engine).is_ok(),
        "managed service requires Docker and an explicit engine",
    )?;
    crate::config::validation::require(
        IMAGE.is_match(&runtime.image),
        "service image must be pinned by a SHA-256 digest",
    )
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Container runner and immutable image used by a managed service installer.
pub struct ServiceRuntime {
    #[serde(rename = "provider")]
    /// Supported container runner. The initial service contract uses Docker.
    pub provider: String,
    #[serde(rename = "engine")]
    /// Explicit Docker endpoint used to install, observe, and remove the service.
    pub engine: String,
    #[serde(rename = "image")]
    /// Immutable image reference used by the package installer.
    pub image: String,
    /// Image acquisition before create or restart. Omission means Never for vLLM and IfNotPresent for Ollama and its proxy.
    #[serde(
        rename = "imagePullPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "crate::config::ImagePullPolicy")]
    pub image_pull_policy: Option<crate::config::ImagePullPolicy>,
}

/// OpenTofu stage that executes an installer plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallStage {
    Runtime,
    Deployment,
}

/// Declarative install result. OpenTofu performs the mutations in dependency order.
pub(crate) struct InstallPlan {
    pub targets: Vec<crate::compile::Target>,
    pub dependencies: std::collections::BTreeMap<String, Vec<String>>,
}

/// Destroy-time policy returned by an installer.
#[derive(Default)]
pub(crate) struct RemovePlan {
    pub retained: Vec<String>,
    pub required_storage: Vec<(String, String)>,
}

/// A managed package supports only install, a bounded post-install check, and remove.
pub(crate) trait Installer {
    fn install(
        &self,
        document: &crate::config::Document,
        name: &str,
        generations: &crate::compile::Generations,
    ) -> Result<InstallPlan, crate::Error>;

    async fn check_running(
        &self,
        document: &crate::config::Document,
        name: &str,
        generations: &crate::compile::Generations,
        connections: &crate::docker::Connections,
        bindings: &std::collections::BTreeMap<String, crate::state::StateBinding>,
        cancel: &crate::CancellationToken,
    ) -> Result<(), crate::Error>;

    fn remove(
        &self,
        document: &crate::config::Document,
        name: &str,
        generations: &crate::compile::Generations,
    ) -> Result<RemovePlan, crate::Error>;
}
