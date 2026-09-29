// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use nemoclaw_sdk::config::ExplicitPolicy;

// Baseline grants follow NVIDIA/OpenShell crates/openshell-supervisor/src/lib.rs
// at 7e7a8d5610f336f5f7f9f60da0951adbf295475d (Apache-2.0).
// 2026-09-17: compare image-dependent proxy additions without changing authored
// grants, accepting unrelated paths, or upgrading explicit read-only grants.
pub(super) fn loaded_policy_matches(
    loaded: &proto::SandboxPolicy,
    expected: &str,
) -> Result<bool, ObservationError> {
    let actual = policy_json(loaded)?;
    if actual == expected {
        return Ok(true);
    }
    let mut baseline = row_policy(&[("policy_json".into(), expected.into())].into())?;
    if baseline.network_policies.is_empty() {
        return Ok(false);
    }
    let Some(observed) = &loaded.filesystem else {
        return Ok(false);
    };
    let fs = baseline
        .filesystem
        .get_or_insert_with(|| proto::FilesystemPolicy {
            include_workdir: true,
            ..Default::default()
        });
    // OpenShell adds only paths present in the sandbox image. Host filesystem
    // probes cannot establish that set; accept only observed, known additions.
    for (paths, writable) in [
        (
            &[
                "/usr",
                "/lib",
                "/etc",
                "/app",
                "/var/log",
                "/proc",
                "/dev/urandom",
            ][..],
            false,
        ),
        (&["/tmp", "/dev/null"][..], true),
    ] {
        for path in paths {
            let observed_paths = if writable {
                &observed.read_write
            } else {
                &observed.read_only
            };
            if observed_paths.iter().any(|p| p == path)
                && !fs.read_only.iter().chain(&fs.read_write).any(|p| p == path)
            {
                if writable {
                    &mut fs.read_write
                } else {
                    &mut fs.read_only
                }
                .push((*path).into());
            }
        }
    }
    Ok(policy_json(&baseline)? == actual)
}

pub(super) fn row_policy(row: &Row) -> Result<proto::SandboxPolicy, ObservationError> {
    match row.get("policy_json").map(String::as_str).unwrap_or("") {
        "" => Ok(policy()),
        text => {
            let policy: ExplicitPolicy =
                serde_json::from_str(text).map_err(|_| ObservationError::Query)?;
            policy.to_proto().map_err(|_| ObservationError::Query)
        }
    }
}
