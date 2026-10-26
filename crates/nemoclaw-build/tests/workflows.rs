// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Rules the GitHub workflows must follow that only show up when a run is
//! skipped or refused to start.

use std::{collections::BTreeSet, fs, path::PathBuf};

use serde_json::Value;

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Each workflow and composite action, by its path in the repository.
fn definitions() -> Vec<(String, String)> {
    let root = repository();
    let mut found = Vec::new();
    for directory in [".github/workflows", ".github/actions"] {
        let mut pending = vec![root.join(directory)];
        while let Some(path) = pending.pop() {
            for entry in fs::read_dir(&path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|extension| extension == "yml") {
                    let name = path.strip_prefix(&root).unwrap().display().to_string();
                    found.push((name, fs::read_to_string(&path).unwrap()));
                }
            }
        }
    }
    found.sort();
    found
}

fn needs(job: &Value) -> Vec<String> {
    match &job["needs"] {
        Value::String(name) => vec![name.clone()],
        Value::Array(names) => names
            .iter()
            .filter_map(|name| name.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// GitHub skips a job whose needed job was skipped unless the job's `if:`
/// uses a status function, and a skipped job counts as passing (#13699). So a
/// job that needs a job with an `if:` must say what happens when that job is
/// skipped: its own `if:` checks `needs.<job>.result` or uses a status
/// function.
#[test]
fn jobs_say_what_happens_when_a_job_they_need_is_skipped() {
    let status = ["always()", "cancelled()", "success()", "failure()"];
    let mut problems = Vec::new();
    for (path, text) in definitions() {
        if !path.starts_with(".github/workflows/") {
            continue;
        }
        let workflow: Value = serde_saphyr::from_str(&text).unwrap();
        let Some(jobs) = workflow["jobs"].as_object() else {
            continue;
        };
        for (name, job) in jobs {
            let condition = job["if"].as_str().unwrap_or_default();
            if status.iter().any(|function| condition.contains(function)) {
                continue;
            }
            for needed in needs(job) {
                let skippable = jobs
                    .get(&needed)
                    .is_some_and(|needed| !needed["if"].is_null());
                if skippable && !condition.contains(&format!("needs.{needed}.result")) {
                    problems.push(format!(
                        "{path}: job {name} needs {needed}, which can be skipped; check needs.{needed}.result or use a status function in its if:"
                    ));
                }
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// The organization allows GitHub's and NVIDIA's actions and verified
/// creators' at any version, and other actions only at the commits it lists;
/// any other action stops its whole workflow from starting (#13612).
/// `.github/allowed-actions.yml` records what applies to the actions in use.
#[test]
fn third_party_actions_use_commits_the_organization_allows() {
    let allowed: Value = serde_saphyr::from_str(
        &fs::read_to_string(repository().join(".github/allowed-actions.yml")).unwrap(),
    )
    .unwrap();
    let list = |key: &str| -> BTreeSet<String> {
        allowed[key]
            .as_array()
            .unwrap_or_else(|| panic!("allowed-actions.yml lists no {key}"))
            .iter()
            .map(|entry| entry.as_str().unwrap().to_owned())
            .collect()
    };
    let creators = list("verified-creators");
    let commits = list("commits");
    let mut used = BTreeSet::new();
    let mut problems = Vec::new();
    for (path, text) in definitions() {
        for line in text.lines() {
            let Some(action) = line
                .trim_start()
                .trim_start_matches("- ")
                .strip_prefix("uses:")
                .and_then(|rest| rest.split_whitespace().next())
            else {
                continue;
            };
            let owner = action.split('/').next().unwrap_or_default();
            if action.starts_with("./") || ["actions", "github", "NVIDIA"].contains(&owner) {
                continue;
            }
            used.insert(action.to_owned());
            if !creators.contains(owner) && !commits.contains(action) {
                problems.push(format!(
                    "{path}: {action} is not an action the organization allows; ask an organization admin to allow this commit, then list it in .github/allowed-actions.yml"
                ));
            }
        }
    }
    for commit in commits.difference(&used) {
        problems.push(format!(
            ".github/allowed-actions.yml lists {commit}, which no workflow uses"
        ));
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
