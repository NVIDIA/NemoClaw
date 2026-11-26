// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Remove only the Docker objects owned by a completed live test run.

use serde_json::Value;
use sha2::{Digest as _, Sha256};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
};

pub const UID_LABEL: &str = "nemoclaw.nvidia.com/uid";
pub const SANDBOX_NAMESPACE_LABEL: &str = "openshell.ai/sandbox-namespace";

/// OpenShell labels sandbox objects with the managed gateway's workspace.
pub fn sandbox_filter(uid: &str) -> String {
    let digest = crate::hex(&Sha256::digest(uid.as_bytes()));
    let workspace = format!("nc-{}", &digest[..16]);
    format!("label={SANDBOX_NAMESPACE_LABEL}={workspace}-gateway")
}

/// Object kinds in removal order: Docker refuses to remove a volume or
/// network that a container still uses.
const RETAINED: [(&str, &[&str], &[&str]); 3] = [
    (
        "container",
        &["container", "ls", "--all", "--quiet", "--filter"],
        &["container", "rm", "--force"],
    ),
    (
        "volume",
        &["volume", "ls", "--quiet", "--filter"],
        &["volume", "rm"],
    ),
    (
        "network",
        &["network", "ls", "--quiet", "--filter"],
        &["network", "rm"],
    ),
];

/// Remove each UID's labelled objects and its gateway's sandbox objects, then
/// fail naming any sandbox object OpenShell left and anything that remains.
pub fn remove(docker: impl Fn() -> Command, uids: &[String]) -> Result<(), String> {
    remove_objects(docker, uids, true)
}

fn remove_objects(
    docker: impl Fn() -> Command,
    uids: &[String],
    force_containers: bool,
) -> Result<(), String> {
    let list =
        |args: &[&str], filter: &str| super::live::docker_lines(docker().args(args).arg(filter));
    let mut problems = Vec::new();
    for uid in uids {
        let sandbox = sandbox_filter(uid);
        let owner = format!("label={UID_LABEL}={uid}");
        for (kind, ls, _) in RETAINED {
            problems.extend(
                list(ls, &sandbox)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|id| format!("{kind} {id} left in the sandbox namespace")),
            );
        }
        for (kind, ls, rm) in RETAINED {
            let rm = if kind == "container" && !force_containers {
                &["container", "rm"][..]
            } else {
                rm
            };
            for filter in [&sandbox, &owner] {
                for id in list(ls, filter).unwrap_or_default() {
                    let _ = docker().args(rm).arg(&id).stdout(Stdio::null()).status();
                }
            }
        }
        for (kind, ls, _) in RETAINED {
            for filter in [&sandbox, &owner] {
                match list(ls, filter) {
                    Some(ids) => problems.extend(
                        ids.into_iter()
                            .map(|id| format!("{kind} {id} remains after removal")),
                    ),
                    None => problems.push(format!("cannot list {kind}s with {filter}")),
                }
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "live Docker cleanup failed: {}",
            problems.join(", ")
        ))
    }
}

/// Finish a hardware test only after its teardown receipts establish ownership and quiescence.
pub fn cleanup_hardware(
    docker: impl Fn() -> Command,
    reports: &Path,
    uid: &str,
    case: &str,
) -> Result<(), String> {
    let station = crate::hcl_cases::STATION_CASES.contains(&case);
    if !station && case != "dgx-spark-openclaw-nemotron" {
        return Err("retained hardware cleanup requires a Station or Spark case".into());
    }
    let read = |file: &str| -> Result<Value, String> {
        let bytes = fs::read(reports.join(file))
            .map_err(|_| format!("{file} is unavailable; preserve this run for recovery"))?;
        serde_json::from_slice(&bytes)
            .map_err(|_| format!("{file} is invalid; preserve this run for recovery"))
    };
    let identity = read("identity.json")?;
    if identity["uid"].as_str() != Some(uid) || identity["case"].as_str() != Some(case) {
        return Err("cleanup identity differs from this run; preserve its resources".into());
    }
    if read("destroy.json")?["outcome"] != "destroyed"
        || read("cleanup.json")?["succeeded"] != true
        || (station && read("model-cache-cleanup.json")?["succeeded"] != true)
    {
        return Err("hardware teardown is not confirmed; preserve this run for recovery".into());
    }
    let sandbox = sandbox_filter(uid);
    let owner = format!("label={UID_LABEL}={uid}");
    let list = |args: &[&str], filter: &str| {
        super::live::docker_lines(docker().args(args).arg(filter)).ok_or_else(|| {
            "Docker inventory is unavailable; preserve this run for recovery".to_owned()
        })
    };
    for filter in [&sandbox, &owner] {
        if !list(&["container", "ls", "--quiet", "--filter"], filter)?.is_empty() {
            return Err("a runtime is still running; preserve this run for recovery".into());
        }
        for (_, ls, _) in RETAINED {
            list(ls, filter)?;
        }
    }
    // Do not force-remove a container that starts after the inventory check.
    remove_objects(docker, &[uid.to_owned()], false)
}
