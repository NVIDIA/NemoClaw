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

fn colossus_workflow() -> Value {
    serde_saphyr::from_str(
        &fs::read_to_string(repository().join(".github/workflows/colossus-connectivity.yml"))
            .unwrap(),
    )
    .unwrap()
}

/// Only manual v1 dispatches can execute jobs on the leased machine's runner,
/// and a dispatch selects one of them.
#[test]
fn colossus_runs_are_manual_and_v1_only() {
    let workflow = colossus_workflow();
    let events = workflow["on"]
        .as_object()
        .expect("explicit workflow events");
    assert_eq!(events.len(), 1, "the pilot runner takes manual runs only");
    let suite = &workflow["on"]["workflow_dispatch"]["inputs"]["suite"];
    assert_eq!(suite["type"], "choice");
    assert_eq!(
        suite["options"],
        serde_json::json!(["smoke", "bundle", "nemotron"])
    );
    assert_eq!(suite["default"], "smoke");
    let jobs = workflow["jobs"].as_object().expect("workflow jobs");
    assert_eq!(
        jobs.keys().map(String::as_str).collect::<Vec<_>>(),
        ["bundle", "nemotron", "smoke"]
    );
    for (name, job) in jobs {
        assert_eq!(
            job["if"],
            format!(
                "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/v1' && github.event_name == 'workflow_dispatch' && inputs.suite == '{name}'"
            ),
            "only a manual dispatch on the canonical v1 branch may execute {name}"
        );
    }
    assert!(
        !workflow.to_string().contains("secrets"),
        "no secret references or inherited secrets"
    );
    assert_eq!(workflow["permissions"], serde_json::json!({}));
    assert!(
        workflow["env"].is_null(),
        "no workflow environment variables"
    );
}

/// The smoke test performs no checkout, secret handling, or hardware commands.
#[test]
fn colossus_smoke_executes_only_true_without_credentials() {
    let workflow = colossus_workflow();
    let job = &workflow["jobs"]["smoke"];
    assert_eq!(job["runs-on"], "colossus-gb300-pilot");
    assert_eq!(job["timeout-minutes"], 2);
    assert!(job["permissions"].is_null(), "inherit empty permissions");
    assert!(
        job["environment"].is_null(),
        "no protected-environment secrets"
    );
    assert!(job["env"].is_null(), "no job environment variables");
    let steps = job["steps"].as_array().expect("smoke steps");
    assert_eq!(steps.len(), 1);
    assert!(steps[0]["uses"].is_null(), "no checkout or other actions");
    assert!(steps[0]["env"].is_null(), "no step environment variables");
    assert_eq!(steps[0]["shell"], "bash");
    assert_eq!(steps[0]["run"], "true");
}

/// The bundle suite runs the Linux ARM64 bundle, unit, contract, and
/// integration jobs on the pilot runner, to compare its timings with the
/// hosted runners'. It reads the shared Rust caches but never writes them, so
/// hosted v1 runs never restore artifacts built on the leased machine.
#[test]
fn colossus_bundle_runs_linux_arm64_ci_without_writing_shared_caches() {
    let workflow = colossus_workflow();
    let job = &workflow["jobs"]["bundle"];
    assert_eq!(job["uses"], "./.github/workflows/bundle-platform.yml");
    assert_eq!(
        job["permissions"],
        serde_json::json!({"contents": "read", "packages": "read"}),
        "only what bundle-platform.yml declares"
    );
    assert_eq!(
        job["with"],
        serde_json::json!({
            "runner": "colossus-gb300-pilot",
            "platform": "linux_arm64",
            "bundle": true,
            "lifecycle": true,
            "e2e": false,
            "save-cache": false,
        })
    );

    let platform: Value = serde_saphyr::from_str(
        &fs::read_to_string(repository().join(".github/workflows/bundle-platform.yml")).unwrap(),
    )
    .unwrap();
    let input = &platform["on"]["workflow_call"]["inputs"]["save-cache"];
    assert_eq!(input["type"], "boolean");
    assert_eq!(input["default"], true, "CI / Bundle keeps saving on v1");
    let mut setups = 0;
    for (name, job) in platform["jobs"].as_object().unwrap() {
        for step in job["steps"].as_array().into_iter().flatten() {
            if step["uses"] == "./.github/actions/setup-rust" {
                setups += 1;
                assert_eq!(
                    step["with"]["save-cache"], "${{ inputs.save-cache }}",
                    "{name} must honor save-cache"
                );
            }
        }
    }
    assert!(setups > 0, "bundle-platform.yml sets up Rust");
}

/// Linux bundles must run on Ubuntu 22.04, the oldest supported Linux, so
/// `CI / Bundle` builds them there and checks that none of their executables
/// needs a newer glibc. Tests run where the default runners are: executables
/// built against an older glibc run on newer ones.
#[test]
fn linux_bundles_build_on_ubuntu_22_04_and_check_its_glibc() {
    let workflow: Value = serde_saphyr::from_str(
        &fs::read_to_string(repository().join(".github/workflows/rust.yml")).unwrap(),
    )
    .unwrap();
    for (platform, builder) in [
        ("linux_arm64", "ubuntu-22.04-arm"),
        ("linux_amd64", "ubuntu-22.04"),
    ] {
        let with = &workflow["jobs"][platform]["with"];
        assert_eq!(with["build-runner"], builder, "{platform}");
        assert_eq!(with["glibc"], "2.35", "{platform}");
    }
    for platform in ["darwin_arm64", "windows_amd64"] {
        let with = &workflow["jobs"][platform]["with"];
        assert!(with["glibc"].is_null(), "{platform} has no glibc");
    }

    let platform: Value = serde_saphyr::from_str(
        &fs::read_to_string(repository().join(".github/workflows/bundle-platform.yml")).unwrap(),
    )
    .unwrap();
    for job in ["build", "bundle"] {
        assert_eq!(
            platform["jobs"][job]["runs-on"], "${{ inputs.build-runner || inputs.runner }}",
            "{job}"
        );
    }
    let check = platform["jobs"]["bundle"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|step| {
            step["run"]
                .as_str()
                .is_some_and(|run| run.contains("check-glibc"))
        })
        .expect("the bundle job checks the glibc floor");
    assert_eq!(check["if"], "inputs.glibc != ''");
}

/// On `v1` pushes and manual runs, `CI / Bundle` runs the GPU HCL cases
/// through Live / HCL from Linux AMD64's test archive, bundle, and live
/// images, so Live / HCL builds no candidate of its own. Only a run without
/// those artifacts, such as a dispatch, builds one.
#[test]
fn ci_bundle_runs_the_gpu_cases_from_its_linux_amd64_artifacts() {
    let read = |path: &str| -> Value {
        serde_saphyr::from_str(&fs::read_to_string(repository().join(path)).unwrap()).unwrap()
    };
    let callers: Vec<String> = definitions(&repository())
        .into_iter()
        .flat_map(|(path, workflow)| {
            let jobs = workflow["jobs"].as_object().cloned().unwrap_or_default();
            jobs.into_iter()
                .filter(|(_, job)| job["uses"] == "./.github/workflows/hcl-e2e.yml")
                .map(move |(name, _)| format!("{path}: {name}"))
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(
        callers,
        [".github/workflows/e2e-platform.yml: gpu"],
        "only the E2E platform workflow, which has the artifacts, calls Live / HCL"
    );

    let platform = read(".github/workflows/e2e-platform.yml");
    let gpu = &platform["jobs"]["gpu"];
    assert!(needs(gpu).contains(&"live-images".to_owned()));
    assert_eq!(
        gpu["with"],
        serde_json::json!({
            "hosted": false,
            "cases": "${{ inputs.hcl-cases }}",
            "tests": "${{ inputs.tests }}",
            "bundle": "${{ inputs.bundle }}",
            "live-images": "${{ needs.live-images.outputs.artifact }}",
            "live-images-commit": "${{ inputs.live-images-commit }}",
        })
    );
    let bundle_platform = read(".github/workflows/bundle-platform.yml");
    assert_eq!(
        bundle_platform["jobs"]["e2e"]["with"]["hcl-gpu"],
        "${{ inputs.hcl-gpu }}"
    );

    let live = read(".github/workflows/hcl-e2e.yml");
    let build = live["jobs"]["build"]["if"].as_str().unwrap_or_default();
    assert!(
        build.contains("inputs.tests == ''"),
        "Live / HCL builds a candidate only without CI / Bundle's artifacts: {build}"
    );
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

/// The manual hardware lane reuses the real HCL boundary and reserves cleanup.
#[test]
fn colossus_nemotron_runs_the_live_case_with_terminal_cleanup() {
    let workflow = colossus_workflow();
    let job = &workflow["jobs"]["nemotron"];
    assert_eq!(job["runs-on"], "colossus-gb300-pilot");
    assert_eq!(job["permissions"], serde_json::json!({"contents": "read"}));
    assert_eq!(job["timeout-minutes"], 135);
    assert_eq!(job["env"]["NEMOCLAW_HCL_CASE"], "gb300-openclaw-nemotron35");
    let steps = job["steps"].as_array().expect("manual lifecycle steps");
    let cleanup = steps
        .iter()
        .find(|step| step["id"] == "cleanup")
        .expect("terminal cleanup");
    assert_eq!(cleanup["if"], "always()");
    assert_eq!(cleanup["timeout-minutes"], 10);
    let lifecycle = steps
        .iter()
        .find(|step| step["id"] == "lifecycle")
        .expect("live case");
    assert_eq!(lifecycle["working-directory"], "crates/nemoclaw-e2e");
    assert!(
        lifecycle["run"]
            .as_str()
            .unwrap()
            .contains("hcl_live::case")
    );
    for step in steps {
        if step["uses"]
            .as_str()
            .is_some_and(|action| action.starts_with("actions/checkout@"))
        {
            assert_eq!(step["with"]["persist-credentials"], false);
        }
    }
}

/// A denied host or failed compiler bootstrap must not continue with stale artifacts.
#[test]
#[cfg(unix)]
fn colossus_preparation_stops_and_keeps_native_errors_private() {
    use std::{os::unix::fs::PermissionsExt, process::Command};
    let workflow = colossus_workflow();
    let script = workflow["jobs"]["nemotron"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|step| step["name"] == "Build candidate artifacts and bind the case")
        .unwrap()["run"]
        .as_str()
        .unwrap();
    for failed in ["uname", "nvidia-smi", "rustup", "tools-env", "tools-path"] {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(root.path().join("work")).unwrap();
        for name in [
            "uname",
            "nvidia-smi",
            "rustup",
            "cargo",
            "docker",
            "cp",
            "jq",
            "protoc",
        ] {
            let contents = match name {
                "uname" if failed != "uname" => "#!/bin/sh\necho aarch64\n".to_owned(),
                "uname" => "#!/bin/sh\necho unsupported\n".to_owned(),
                "nvidia-smi" if failed != "nvidia-smi" => {
                    "#!/bin/sh\necho 'NVIDIA GB300'\n".to_owned()
                }
                "rustup" if failed.starts_with("tools-") => "#!/bin/sh\nexit 0\n".to_owned(),
                "protoc" => "#!/bin/sh\nexit 0\n".to_owned(),
                "jq" => "#!/bin/sh\necho 36.2\n".to_owned(),
                "cargo" if failed.starts_with("tools-") => r#"#!/bin/sh
if [ "$*" = 'ci tools' ]; then
  mkdir -p .tools/protoc-36.2/bin
  printf '#!/bin/sh\nexit 0\n' > .tools/protoc-36.2/bin/protoc
  chmod +x .tools/protoc-36.2/bin/protoc
  echo "PROTOC=$SELECTED_PROTOC" >> "$GITHUB_ENV"
  exit 0
fi
if [ "$PROTOC" = "$SELECTED_PROTOC" ]; then
  touch tool-env-passed
fi
exit 23
"#
                .to_owned(),
                "nvidia-smi" | "rustup" => {
                    "#!/bin/sh\necho private-diagnostic-marker >&2\nexit 23\n".to_owned()
                }
                _ => r#"#!/bin/sh
touch "$SENTINEL"
exit 99
"#
                .to_owned(),
            };
            let path = bin.join(name);
            fs::write(&path, contents).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        // The operating-system check is supplied by the owned live host; these
        // isolated tests exercise failure control without reading the test host's OS.
        let script = script.replace(". /etc/os-release", "ID=ubuntu; VERSION_ID=24.04");
        let output = Command::new("bash")
            .args(["-e", "-o", "pipefail", "-c", &script])
            .env_clear()
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("NEMOCLAW_HCL_RUN", root.path())
            .env("SENTINEL", root.path().join("continued"))
            .env("GITHUB_ENV", root.path().join("github-env"))
            .env(
                "SELECTED_PROTOC",
                if failed == "tools-path" {
                    "protoc".to_owned()
                } else {
                    root.path()
                        .join(".tools/protoc-36.2/bin/protoc")
                        .display()
                        .to_string()
                },
            )
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(!output.status.success(), "{failed} must fail preparation");
        if failed.starts_with("tools-") {
            assert!(
                root.path().join("tool-env-passed").exists(),
                "the direct build needs the tools installed in the same step"
            );
        }
        assert!(
            !root.path().join("continued").exists(),
            "{failed} continued into a build"
        );
        let public = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !public.contains("private-diagnostic-marker"),
            "raw native output escaped"
        );
        assert!(public.contains("Candidate preparation failed"));
    }
}

/// A successful CLI receipt is insufficient when Docker cannot confirm absence.
#[test]
#[cfg(unix)]
fn colossus_cleanup_fails_for_unobserved_or_remaining_owned_containers() {
    use std::{os::unix::fs::PermissionsExt, process::Command};
    let workflow = colossus_workflow();
    let script = workflow["jobs"]["nemotron"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|step| step["id"] == "cleanup")
        .unwrap()["run"]
        .as_str()
        .unwrap();
    for scenario in ["unreachable", "remaining", "network_remaining", "absent"] {
        let root = tempfile::tempdir().unwrap();
        for path in ["bin", "bundle/bin", "work", "reports", "deployment"] {
            fs::create_dir_all(root.path().join(path)).unwrap();
        }
        fs::write(
            root.path().join("uid"),
            "35a87971-1114-44f9-92cd-ab7a27a3e603",
        )
        .unwrap();
        let cli = root.path().join("bundle/bin/nemoclaw");
        fs::write(
            &cli,
            "#!/bin/sh\necho '{\"outcome\":\"destroyed\",\"retained\":[]}'\n",
        )
        .unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
        let docker = root.path().join("bin/docker");
        fs::write(
            &docker,
            match scenario {
                "unreachable" => "#!/bin/sh\nexit 7\n",
                "remaining" => "#!/bin/sh\necho owned-container\n",
                "network_remaining" => {
                    "#!/bin/sh\nif [ \"$1\" = network ]; then echo owned-network; fi\n"
                }
                _ => "#!/bin/sh\nexit 0\n",
            },
        )
        .unwrap();
        fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
        let output = Command::new("bash")
            .args(["-e", "-x", "-o", "pipefail", "-c", script])
            .env_clear()
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    root.path().join("bin").display(),
                    std::env::var("PATH").unwrap()
                ),
            )
            .env("NEMOCLAW_HCL_RUN", root.path())
            .env("NEMOCLAW_TEST_BUNDLE", root.path().join("bundle"))
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            scenario == "absent",
            "{scenario}: stdout={}, stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            root.path().join("reports/cleanup.json").exists(),
            scenario == "absent"
        );
    }
}

/// Native replies, generated keys, state and diagnostics must remain private.
#[test]
fn colossus_uploads_only_allowlisted_outcomes() {
    let workflow = colossus_workflow();
    let steps = workflow["jobs"]["nemotron"]["steps"].as_array().unwrap();
    let upload = steps
        .iter()
        .find(|step| {
            step["uses"]
                .as_str()
                .is_some_and(|value| value.starts_with("actions/upload-artifact@"))
        })
        .unwrap();
    assert_eq!(
        upload["with"]["path"]
            .as_str()
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        [
            "${{ env.NEMOCLAW_HCL_RUN }}/reports/candidate.json",
            "${{ env.NEMOCLAW_HCL_RUN }}/reports/outcome.json",
            "${{ env.NEMOCLAW_HCL_RUN }}/reports/cleanup.json",
        ]
    );
}
