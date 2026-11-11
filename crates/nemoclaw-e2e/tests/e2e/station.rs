// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The Station's retained network needs a fresh subnet on a later run.
//! SDK destroy owns mutation; this probe only observes what Docker retained.

use nemoclaw_sdk::config::Document;
use serde_json::{Value, json};
use std::{env, fs, path::Path, process::Command};

fn docker(args: &[&str]) -> String {
    let output = Command::new("docker")
        .args(["--host", "unix:///var/run/docker.sock"])
        .args(args)
        .output()
        .expect("run Docker observation");
    assert!(output.status.success(), "Docker observation failed");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn free_subnet(networks: &[Value]) -> Option<String> {
    let used: Vec<&str> = networks
        .iter()
        .flat_map(|network| {
            network["IPAM"]["Config"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|config| config["Subnet"].as_str())
        })
        .collect();
    (200..=254)
        .map(|n| format!("172.30.{n}.0/24"))
        .find(|subnet| !used.contains(&subnet.as_str()))
}

/// Finish the workflow's copied example without changing the source or an
/// existing deployment. Image compatibility and capacity are checked by apply.
pub(super) fn bind(run: &Path, input: &str) -> String {
    let path = run.join("case.json");
    assert!(
        !path.exists() && !run.join("deployment").exists(),
        "use a fresh Station run"
    );
    let mut document: Value = serde_saphyr::from_str(&fs::read_to_string(input).unwrap()).unwrap();
    let networks = docker(&["network", "ls", "--quiet"]);
    let mut observed = Vec::new();
    for id in networks.lines() {
        let values: Vec<Value> =
            serde_json::from_str(&docker(&["network", "inspect", id])).unwrap();
        observed.extend(values);
    }
    document["spec"]["gateway"]["networkCIDR"] = free_subnet(&observed)
        .expect("no free Station subnet")
        .into();
    fs::write(&path, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
    fs::write(
        run.join("reports/identity.json"),
        serde_json::to_vec_pretty(&json!({
            "candidate": env::var("GITHUB_SHA").expect("record the tested commit"),
            "platform": env::var("TEST_PLATFORM").expect("record the tested platform"),
            "case": env::var("NEMOCLAW_HCL_CASE").unwrap(),
            "deployment_uid": document["metadata"]["uid"],
            "model": document["spec"]["services"]["super"]["model"],
            "openclaw_image": document["spec"]["sandboxes"]["assistant"]["image"]["ref"],
            "runtime_image": document["spec"]["services"]["super"]["image"],
            "model_cache": "fresh deployment-owned volume; no prior cache imported",
        }))
        .unwrap(),
    )
    .unwrap();
    path.to_str().unwrap().to_owned()
}

fn containers(filter: &str) -> Vec<Value> {
    let ids = docker(&["container", "ls", "--all", "--quiet", "--filter", filter]);
    if ids.is_empty() {
        return Vec::new();
    }
    let mut args = vec!["container", "inspect"];
    args.extend(ids.lines());
    let observed: Vec<Value> = serde_json::from_str(&docker(&args)).unwrap();
    assert_eq!(
        observed.len(),
        ids.lines().count(),
        "incomplete Docker observation"
    );
    observed
}

fn runtime_absent(owner: &[Value], sandbox: &[Value], workspace: &str) -> bool {
    sandbox.is_empty()
        && owner.iter().all(|container| {
            container["Name"] == format!("/{workspace}-gateway-initialize")
                && container["State"]["Status"] == "exited"
                && container["State"]["ExitCode"] == 0
        })
}

#[test]
#[ignore = "live: observes owned Station Docker resources after SDK destroy"]
fn cleanup() {
    let run = std::path::PathBuf::from(env::var("NEMOCLAW_HCL_RUN").unwrap());
    let document = Document::parse(fs::File::open(run.join("case.json")).unwrap()).unwrap();
    let workspace = document.workspace();
    let owner = format!("label=nemoclaw.nvidia.com/uid={}", document.metadata.uid);
    let sandbox = format!("label=openshell.ai/sandbox-namespace={workspace}-gateway");
    let mut clean = runtime_absent(&containers(&owner), &containers(&sandbox), &workspace);
    for (kind, suffixes) in [
        ("network", vec!["network"]),
        (
            "volume",
            vec![
                "gateway-data",
                "inference-super-data",
                "inference-super-auth",
            ],
        ),
    ] {
        let names = docker(&[kind, "ls", "--format", "{{.Name}}", "--filter", &owner]);
        clean &= names.lines().all(|name| {
            suffixes
                .iter()
                .any(|suffix| name == format!("{workspace}-{suffix}"))
        });
    }
    fs::write(
        run.join("reports/cleanup.json"),
        json!({"succeeded":clean}).to_string(),
    )
    .unwrap();
    assert!(
        clean,
        "unexpected owned Docker resources remain after destroy"
    );
}

#[test]
fn subnet_selection_skips_retained_networks_and_refuses_exhaustion() {
    let networks: Vec<_> = (200..=254)
        .map(|n| json!({"IPAM":{"Config":[{"Subnet":format!("172.30.{n}.0/24")}]}}))
        .collect();
    assert_eq!(
        free_subnet(&networks[..1]).as_deref(),
        Some("172.30.201.0/24")
    );
    assert_eq!(free_subnet(&networks), None);
}

#[test]
fn only_a_successful_exited_initializer_may_remain() {
    let initializer =
        json!({"Name":"/nc-test-gateway-initialize","State":{"Status":"exited","ExitCode":0}});
    assert!(runtime_absent(
        std::slice::from_ref(&initializer),
        &[],
        "nc-test"
    ));
    for leftover in [
        json!({"Name":"/nc-test-inference-super","State":{"Status":"exited","ExitCode":0}}),
        json!({"Name":"/nc-test-gateway-initialize","State":{"Status":"running","ExitCode":0}}),
        json!({"Name":"/nc-test-gateway-initialize","State":{"Status":"exited","ExitCode":1}}),
    ] {
        assert!(!runtime_absent(&[leftover], &[], "nc-test"));
    }
    assert!(!runtime_absent(&[], &[initializer], "nc-test"));
}

#[test]
#[cfg(target_os = "linux")]
fn workflow_binds_the_example_and_refuses_a_failed_image_lookup() {
    use std::os::unix::fs::PermissionsExt;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let workflow: Value = serde_saphyr::from_str(
        &fs::read_to_string(root.join(".github/workflows/colossus-connectivity.yml")).unwrap(),
    )
    .unwrap();
    let script = workflow["jobs"]["station"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|step| step["name"] == "Bind the Station example")
        .unwrap()["run"]
        .as_str()
        .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let docker = temp.path().join("docker");
    fs::write(
        &docker,
        format!(
            "#!/bin/sh\n[ -z \"$LOOKUP_FAIL\" ] || exit 1\nprintf 'sha256:{}\\n'\n",
            "a".repeat(64)
        ),
    )
    .unwrap();
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
    let path = temp.path().join("case.yaml");
    let run = |fault: &str| {
        Command::new("bash")
            .args(["-euo", "pipefail", "-c", script])
            .current_dir(&root)
            .env("PATH", format!("{}:/usr/bin:/bin", temp.path().display()))
            .env("LOOKUP_FAIL", fault)
            .env("NEMOCLAW_HCL_DOCUMENT", &path)
            .output()
            .unwrap()
    };
    assert!(run("").status.success());
    let bytes = fs::read(&path).unwrap();
    let bound = Document::parse(bytes.as_slice()).unwrap();
    let example = Document::parse(
        fs::File::open(root.join("examples/gtc-dc/openclaw-dgx-station.yaml")).unwrap(),
    )
    .unwrap();
    assert_ne!(bound.metadata.uid, example.metadata.uid);
    let value: Value = serde_saphyr::from_str(std::str::from_utf8(&bytes).unwrap()).unwrap();
    assert_eq!(
        value["spec"]["services"]["super"]["model"],
        json!({"repository":"nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4","revision":"da5b2650a835292c678994a1fa3fb653250fb508"})
    );
    assert_eq!(
        value["spec"]["services"]["super"]["serving"]["modelName"],
        value["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]["overrides"]["model"]
    );
    assert!(!run("yes").status.success());
    assert_eq!(
        fs::read(path).unwrap(),
        bytes,
        "a failed binding must not overwrite its input"
    );
}
