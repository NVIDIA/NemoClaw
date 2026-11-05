// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Rules the GitHub workflows must follow that only show up when a run is
//! skipped or refused to start.

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Each workflow and composite action, by its path in the repository.
fn definitions(root: &Path) -> Vec<(String, Value)> {
    let mut found = Vec::new();
    for directory in [".github/workflows", ".github/actions"] {
        let mut pending = vec![root.join(directory)];
        while let Some(path) = pending.pop() {
            for entry in fs::read_dir(&path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else if path
                    .extension()
                    .is_some_and(|extension| extension == "yml" || extension == "yaml")
                {
                    let name = path
                        .strip_prefix(root)
                        .unwrap()
                        .display()
                        .to_string()
                        .replace(std::path::MAIN_SEPARATOR, "/");
                    let definition = serde_saphyr::from_str(&fs::read_to_string(&path).unwrap())
                        .unwrap_or_else(|error| panic!("{name}: {error}"));
                    found.push((name, definition));
                }
            }
        }
    }
    found.sort_by(|(left, _), (right, _)| left.cmp(right));
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
    for (path, workflow) in definitions(&repository()) {
        if !path.starts_with(".github/workflows/") {
            continue;
        }
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
    let problems = action_policy_problems(&definitions(&repository()), &creators, &commits);
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

fn action_policy_problems(
    definitions: &[(String, Value)],
    creators: &BTreeSet<String>,
    commits: &BTreeSet<String>,
) -> Vec<String> {
    let mut used = BTreeSet::new();
    let mut problems = Vec::new();
    for (path, definition) in definitions {
        for action in action_references(definition) {
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
    problems
}

/// Only execution references count; `uses:` in scripts or inputs is data.
fn action_references(definition: &Value) -> Vec<&str> {
    let mut references = Vec::new();
    let mut steps = Vec::new();
    if let Some(jobs) = definition["jobs"].as_object() {
        for job in jobs.values() {
            if let Some(action) = job["uses"].as_str() {
                references.push(action);
            }
            if let Some(job_steps) = job["steps"].as_array() {
                steps.extend(job_steps);
            }
        }
    }
    if definition["runs"]["using"].as_str() == Some("composite")
        && let Some(action_steps) = definition["runs"]["steps"].as_array()
    {
        steps.extend(action_steps);
    }
    references.extend(steps.iter().filter_map(|step| step["uses"].as_str()));
    references
}

#[test]
fn quoted_allowed_action_references_are_accepted() {
    let definitions = vec![(
        ".github/workflows/quoted.yml".to_owned(),
        serde_saphyr::from_str(
            r#"
jobs:
  call:
    uses: './.github/workflows/local.yml'
  build:
    steps:
      - uses: "actions/checkout@v4"
      - uses: 'github/codeql-action/init@v3'
      - uses: "NVIDIA/example@main"
      - uses: 'verified/action@v1'
      - uses: "third-party/action@approved"
"#,
        )
        .unwrap(),
    )];
    let problems = action_policy_problems(
        &definitions,
        &BTreeSet::from(["verified".to_owned()]),
        &BTreeSet::from(["third-party/action@approved".to_owned()]),
    );
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn inline_action_references_are_rejected_in_each_execution_location() {
    for (path, text, action) in [
        (
            ".github/workflows/job.yml",
            "jobs: {call: {uses: 'unapproved/repo/.github/workflows/test.yml@main'}}",
            "unapproved/repo/.github/workflows/test.yml@main",
        ),
        (
            ".github/workflows/step.yml",
            "jobs: {build: {steps: [{uses: 'unapproved/action@main'}]}}",
            "unapproved/action@main",
        ),
        (
            ".github/actions/example/action.yml",
            "runs: {using: composite, steps: [{uses: 'unapproved/composite@main'}]}",
            "unapproved/composite@main",
        ),
    ] {
        let problems = action_policy_problems(
            &[(path.to_owned(), serde_saphyr::from_str(text).unwrap())],
            &BTreeSet::new(),
            &BTreeSet::new(),
        );
        assert_eq!(problems.len(), 1, "{path}: {problems:?}");
        assert!(problems[0].contains(path), "{problems:?}");
        assert!(problems[0].contains(action), "{problems:?}");
    }
}

#[test]
fn yaml_and_yml_definitions_are_both_checked() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join(".github/workflows")).unwrap();
    fs::create_dir_all(root.path().join(".github/actions/example")).unwrap();
    let paths = [
        ".github/actions/example/action.yaml",
        ".github/actions/example/action.yml",
        ".github/workflows/test.yaml",
        ".github/workflows/test.yml",
    ];
    for path in paths {
        let text = if path.starts_with(".github/workflows/") {
            "jobs:\n  build:\n    steps:\n      - uses: unapproved/action@main\n"
        } else {
            "runs:\n  using: composite\n  steps:\n    - uses: unapproved/action@main\n"
        };
        fs::write(root.path().join(path), text).unwrap();
    }
    fs::write(root.path().join(".github/workflows/README.md"), "not YAML").unwrap();
    let definitions = definitions(root.path());
    assert_eq!(
        definitions
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>(),
        paths,
    );
    let problems = action_policy_problems(&definitions, &BTreeSet::new(), &BTreeSet::new());
    assert_eq!(problems.len(), paths.len(), "{problems:?}");
    for path in paths {
        assert!(
            problems.iter().any(|problem| problem.contains(path)),
            "{problems:?}"
        );
    }
}

#[test]
fn unlisted_revisions_are_rejected_and_unused_commits_are_reported() {
    let definitions = vec![(
        ".github/workflows/revisions.yml".to_owned(),
        serde_saphyr::from_str(
            "jobs: {build: {steps: [{uses: 'third-party/action@other'}, {uses: 'actions-extra/action@v1'}]}}",
        )
        .unwrap(),
    )];
    let problems = action_policy_problems(
        &definitions,
        &BTreeSet::new(),
        &BTreeSet::from(["third-party/action@approved".to_owned()]),
    );
    assert_eq!(problems.len(), 3, "{problems:?}");
    for action in ["third-party/action@other", "actions-extra/action@v1"] {
        assert!(
            problems.iter().any(|problem| problem.contains(action)
                && problem.contains("is not an action the organization allows")),
            "{problems:?}"
        );
    }
    assert!(
        problems
            .iter()
            .any(|problem| problem.contains("third-party/action@approved")
                && problem.contains("which no workflow uses")),
        "{problems:?}"
    );
}

#[test]
fn uses_in_scripts_and_inputs_do_not_count_as_action_references() {
    let definitions = vec![(
        ".github/actions/example/action.yml".to_owned(),
        serde_saphyr::from_str(
            r#"
runs:
  using: composite
  steps:
    - uses: 'actions/checkout@v4'
      with:
        uses: unapproved/input@main
    - shell: bash
      run: |
        uses: third-party/action@approved
"#,
        )
        .unwrap(),
    )];
    let problems = action_policy_problems(
        &definitions,
        &BTreeSet::new(),
        &BTreeSet::from(["third-party/action@approved".to_owned()]),
    );
    assert_eq!(
        problems,
        [".github/allowed-actions.yml lists third-party/action@approved, which no workflow uses"]
    );
}
