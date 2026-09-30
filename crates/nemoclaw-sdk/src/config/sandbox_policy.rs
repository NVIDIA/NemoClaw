// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{ObservationError, config::ExplicitPolicy};
use openshell_core::proto;

fn canonical(policy: &proto::SandboxPolicy) -> Result<String, ObservationError> {
    let mut policy = policy.clone();
    if let Some(fs) = &mut policy.filesystem {
        fs.read_only.sort();
        fs.read_write.sort();
    }
    let mut value = openshell_policy::sandbox_policy_to_json_value(&policy)
        .map_err(|_| ObservationError::Incomplete)?;
    value
        .as_object_mut()
        .ok_or(ObservationError::Incomplete)?
        .entry("network_policies")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(rules) = value["network_policies"].as_object_mut() {
        for rule in rules.values_mut() {
            let rule = rule.as_object_mut().ok_or(ObservationError::Incomplete)?;
            rule.entry("binaries")
                .or_insert_with(|| serde_json::json!([]));
            rule.entry("endpoints")
                .or_insert_with(|| serde_json::json!([]));
        }
    }
    // Refuse fields the SDK cannot retain, including credential bindings and middleware.
    let typed: ExplicitPolicy =
        serde_json::from_value(value.clone()).map_err(|_| ObservationError::Incomplete)?;
    let decoded = typed.to_proto().map_err(|_| ObservationError::Incomplete)?;
    if decoded != policy {
        return Err(ObservationError::Incomplete);
    }
    value.sort_all_objects();
    Ok(value.to_string())
}
pub fn policy_json(policy: &proto::SandboxPolicy) -> Result<String, ObservationError> {
    canonical(policy)
}
