// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Package-independent service installer input and output.

use std::sync::LazyLock;

static IMAGE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(crate::config::constraints::IMAGE).unwrap());
static LOCAL_IMAGE_ID: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(crate::config::constraints::LOCAL_IMAGE_ID).unwrap());

pub(super) fn validate_image(
    image: &str,
    policy: Option<crate::config::ImagePullPolicy>,
    local_engine: bool,
) -> Result<(), crate::config::ConfigError> {
    if LOCAL_IMAGE_ID.is_match(image) {
        return crate::config::validation::require(
            policy == Some(crate::config::ImagePullPolicy::Never) && local_engine,
            "local Docker image ID requires imagePullPolicy Never on a local engine",
        );
    }
    crate::config::validation::require(
        IMAGE.is_match(image),
        "service image must be pinned by a SHA-256 digest",
    )
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

pub(crate) const MANAGED_SERVICE_KIND: &str = "managed_service";
pub(crate) const MANAGED_SERVICE_STORAGE_KIND: &str = "managed_service_storage";
