// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Package-independent service installer input and output.

/// Escape OpenTofu template sequences in every string of `value`.
pub(crate) fn literal(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => *text = text.replace("${", "$${").replace("%{", "%%{"),
        serde_json::Value::Array(values) => values.iter_mut().for_each(literal),
        serde_json::Value::Object(values) => values.values_mut().for_each(literal),
        _ => {}
    }
}

/// OpenTofu stage that executes an installer plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallStage {
    Runtime,
    Deployment,
}

/// Declarative install result. OpenTofu performs the mutations in dependency order.
#[derive(Default)]
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

/// A managed package supports declarative install and remove.
pub(crate) trait Installer {
    fn install(
        &self,
        document: &crate::config::Document,
        name: &str,
        generations: &crate::compile::Generations,
    ) -> Result<InstallPlan, crate::Error>;

    fn remove(
        &self,
        document: &crate::config::Document,
        name: &str,
        generations: &crate::compile::Generations,
    ) -> Result<RemovePlan, crate::Error>;
}
