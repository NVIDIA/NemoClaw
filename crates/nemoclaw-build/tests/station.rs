// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The manual Station case gets fresh inputs without adopting a deployment.

use serde_json::Value;
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

fn docker_fixture(directory: &Path) {
    let script = directory.join("docker");
    fs::write(
        &script,
        r#"#!/bin/sh
shift 2 # --host and the fixed local socket
case "$1 $2" in
  'container ls')
    [ "${STATION_OBSERVE_FAIL:-0}" = 0 ] || exit 1
    if [ "$3" = --all ]; then printf '%s' "${STATION_LEFTOVER:-}"; else printf '%s' "${STATION_BUSY:-}"; fi ;;
  'container inspect') echo '[{"Name":"/leftover-model","State":{"Status":"running"}}]' ;;
  'network ls') [ "$3" != --quiet ] || echo existing ;;
  'volume ls') ;;
  'network inspect') echo '[{"IPAM":{"Config":[{"Subnet":"172.30.200.0/24"}]}}]' ;;
  'image inspect')
    case "$3" in
      nc-fabric:openclaw) digit=a ;;
      nc-prototype-vllm:station) digit=b ;;
      *) exit 2 ;;
    esac
    digest=$(printf '%064d' 0 | tr 0 "$digit")
    printf '[{"Id":"sha256:%s","Architecture":"%s"}]\n' "$digest" "${STATION_ARCH:-arm64}"
    ;;
  *) exit 2 ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(script, fs::Permissions::from_mode(0o700)).unwrap();
}

fn command(bin: &Path, run: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"));
    command
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args(["station", "prepare", "--run"])
        .arg(run)
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()));
    command
}

#[test]
fn station_preparation_binds_candidate_images_and_fresh_inputs_once() {
    let temp = tempfile::tempdir().unwrap();
    docker_fixture(temp.path());
    let run = temp.path().join("run");
    let result = command(temp.path(), &run).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let doc: Value = serde_json::from_slice(&fs::read(run.join("case.json")).unwrap()).unwrap();
    assert_ne!(
        doc["metadata"]["uid"],
        "26a7dbd6-a34b-467f-9b0c-de3081a998b7"
    );
    assert_eq!(doc["spec"]["gateway"]["networkCIDR"], "172.30.201.0/24");
    assert_eq!(
        doc["spec"]["services"]["super"]["image"],
        format!("nc-prototype-vllm@sha256:{}", "b".repeat(64))
    );
    assert_eq!(
        doc["spec"]["sandboxes"]["assistant"]["image"]["ref"],
        format!("nc-fabric@sha256:{}", "a".repeat(64))
    );
    assert!(!run.join("deployment").exists());
    assert!(
        !command(temp.path(), &run).status().unwrap().success(),
        "must refuse an existing run directory"
    );
}

#[test]
fn station_preparation_refuses_active_workloads_and_wrong_architecture() {
    let temp = tempfile::tempdir().unwrap();
    docker_fixture(temp.path());
    for (key, value) in [
        ("STATION_BUSY", "running-container"),
        ("STATION_ARCH", "amd64"),
    ] {
        let run = temp.path().join(key);
        let result = command(temp.path(), &run).env(key, value).output().unwrap();
        assert!(!result.status.success());
        assert!(
            !run.exists(),
            "failed checks must not leave reusable run inputs"
        );
    }
}

#[test]
fn cleanup_requires_successful_destroy_and_independent_absence_observations() {
    let temp = tempfile::tempdir().unwrap();
    docker_fixture(temp.path());
    let run = temp.path().join("run");
    assert!(command(temp.path(), &run).status().unwrap().success());
    fs::create_dir(run.join("deployment")).unwrap();
    let bundle = temp.path().join("bundle");
    fs::create_dir_all(bundle.join("bin")).unwrap();
    let cli = bundle.join("bin/nemoclaw");
    fs::write(&cli, "#!/bin/sh\n: > \"$STATION_MUTATION_MARKER\"\nprintf 'private diagnostic' >&2\nprintf '{\"outcome\":\"destroyed\"}'\nexit \"${STATION_DESTROY_FAIL:-0}\"\n").unwrap();
    fs::set_permissions(cli, fs::Permissions::from_mode(0o700)).unwrap();
    for (key, value, succeeds) in [
        ("STATION_DESTROY_FAIL", "1", false),
        ("STATION_LEFTOVER", "running-container", false),
        ("STATION_OBSERVE_FAIL", "1", false),
        ("STATION_DESTROY_FAIL", "0", true),
        ("STATION_WRONG_INTENT", "1", false),
    ] {
        let mut document: Value =
            serde_json::from_slice(&fs::read(run.join("case.json")).unwrap()).unwrap();
        if key == "STATION_WRONG_INTENT" {
            document["metadata"]["uid"] = "another-deployment".into();
        }
        fs::write(
            run.join("deployment/intent.json"),
            serde_json::to_vec(&serde_json::json!({"document":document})).unwrap(),
        )
        .unwrap();
        let marker = run.join("mutation");
        let _ = fs::remove_file(&marker);
        let result = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
            .args(["station", "cleanup", "--run"])
            .arg(&run)
            .arg("--bundle")
            .arg(&bundle)
            .env("PATH", format!("{}:/usr/bin:/bin", temp.path().display()))
            .env(key, value)
            .env("STATION_MUTATION_MARKER", &marker)
            .output()
            .unwrap();
        assert_eq!(
            result.status.success(),
            succeeds,
            "{key}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let report: Value =
            serde_json::from_slice(&fs::read(run.join("reports/cleanup.json")).unwrap()).unwrap();
        assert_eq!(report["succeeded"], succeeds, "{key}");
        if key == "STATION_WRONG_INTENT" {
            assert!(
                !marker.exists(),
                "a different deployment must not be destroyed"
            );
        }
        assert!(!String::from_utf8_lossy(&result.stderr).contains("private diagnostic"));
        assert!(
            fs::read_to_string(run.join("work/destroy.stderr"))
                .unwrap()
                .contains("private diagnostic")
        );
    }
}
