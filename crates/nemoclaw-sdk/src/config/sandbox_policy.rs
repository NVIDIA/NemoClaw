// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{ObservationError, config::ExplicitPolicy};
use openshell_core::proto;

/// Readable directories required by the packaged Fabric runtime and adapters.
/// Keep these aligned with image/fabric/Dockerfile and the provider launch command.
pub(crate) fn runtime_read_requirements() -> impl Iterator<Item = (&'static str, &'static str)> {
    [
        ("/opt/fabric", "explicit filesystem policy must grant read access to /opt/fabric for the Fabric runtime"),
        ("/opt/nemoclaw", "explicit filesystem policy must grant read access to /opt/nemoclaw for the NemoClaw runtime bridge"),
    ].into_iter()
}

/// Default filesystem and process policy with no network grants.
pub fn isolated_policy() -> proto::SandboxPolicy {
    proto::SandboxPolicy {
        version: 1,
        filesystem: Some(proto::FilesystemPolicy {
            read_only: [
                "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/app", "/opt", "/proc",
            ]
            .map(String::from)
            .to_vec(),
            read_write: [
                "/sandbox",
                "/tmp",
                "/dev/null",
                "/dev/urandom",
                "/home/node",
            ]
            .map(String::from)
            .to_vec(),
            include_workdir: false,
        }),
        landlock: Some(proto::LandlockPolicy {
            compatibility: "best_effort".into(),
        }),
        process: Some(proto::ProcessPolicy {
            run_as_user: "1000".into(),
            run_as_group: "1000".into(),
        }),
        ..Default::default()
    }
}
pub fn isolated_policy_matches(actual: &proto::SandboxPolicy) -> bool {
    let expected = isolated_policy();
    let Some(filesystem) = &actual.filesystem else {
        return false;
    };
    let mut filesystem = filesystem.clone();
    filesystem.read_only.sort();
    filesystem.read_write.sort();
    let mut expected_filesystem = expected.filesystem.unwrap();
    expected_filesystem.read_only.sort();
    expected_filesystem.read_write.sort();
    actual.version == expected.version
        && actual.process == expected.process
        && actual.landlock == expected.landlock
        && filesystem == expected_filesystem
        && actual.network_policies.is_empty()
        && actual.network_middlewares.is_empty()
}

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
    if isolated_policy_matches(policy) {
        return Ok(String::new());
    }
    canonical(policy)
}
