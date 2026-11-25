// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Each live HCL case runs where its document's needs are met.

use nemoclaw_build::hcl_cases::{Runner, needs, on};
use std::fs;

/// A case document from its gateway target and extra `spec` YAML.
fn document(target: &str, spec: &str) -> String {
    format!("kind: NemoClawConfig\nspec:\n  gateway:\n    target:\n      {target}: {{}}\n{spec}")
}

const NVIDIA_KEY: &str = "  inferenceProviders:\n    nvidia:\n      provider: openai\n      credential:\n        env: NVIDIA_INFERENCE_API_KEY\n";
const VLLM: &str = "  services:\n    model:\n      kind: vllm\n";
const STUB_KEY: &str = "  inferenceProviders:\n    stub:\n      provider: openai\n      credential:\n        env: NEMOCLAW_TEST_STUB_KEY\n";

#[test]
fn a_kubernetes_gateway_runs_on_the_kind_cluster() {
    let needed = needs(&document("kubernetes", NVIDIA_KEY)).unwrap();
    assert_eq!(needed.runner, Runner::LiveKind);
}

#[test]
fn an_openshift_gateway_runs_only_on_openshift() {
    let needed = needs(&document("openshift", NVIDIA_KEY)).unwrap();
    assert_eq!(needed.runner, Runner::OpenShift);
}

#[test]
fn a_managed_runtime_image_runs_on_the_gpu_runner_with_any_key_it_reads() {
    let needed = needs(&document("docker", VLLM)).unwrap();
    assert_eq!(needed.runner, Runner::Gpu);
    assert!(!needed.nvidia_key);
    let needed = needs(&document("docker", &format!("{VLLM}{NVIDIA_KEY}"))).unwrap();
    assert_eq!(needed.runner, Runner::Gpu);
    assert!(needed.nvidia_key);
}

#[test]
fn reading_the_nvidia_key_runs_on_hosted_inference() {
    let needed = needs(&document("docker", NVIDIA_KEY)).unwrap();
    assert_eq!(needed.runner, Runner::Hosted);
    assert!(needed.nvidia_key);
}

#[test]
fn other_docker_cases_run_in_the_docker_live_suite() {
    for spec in ["", STUB_KEY] {
        let needed = needs(&document("docker", spec)).unwrap();
        assert_eq!(needed.runner, Runner::LiveDocker, "{spec}");
        assert!(!needed.nvidia_key);
    }
}

#[test]
fn a_suite_runs_its_requested_cases_and_refuses_cases_placed_elsewhere() {
    let root = tempfile::tempdir().unwrap();
    for (id, contents) in [
        ("docker-a", document("docker", "")),
        ("docker-b", document("docker", "")),
        ("hosted-c", document("docker", NVIDIA_KEY)),
    ] {
        for (path, contents) in [
            (format!("crates/nemoclaw-e2e/cases/{id}.yaml"), contents),
            (
                format!("crates/nemoclaw-e2e/tests/e2e/hcl/tests/{id}.tftest.hcl"),
                "\n".into(),
            ),
        ] {
            let path = root.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }
    let docker = |requested: Option<&[&str]>| {
        let requested: Option<Vec<String>> =
            requested.map(|ids| ids.iter().map(|id| id.to_string()).collect());
        on(root.path(), Runner::LiveDocker, requested.as_deref())
    };
    assert_eq!(docker(None).unwrap(), ["docker-a", "docker-b"]);
    assert_eq!(docker(Some(&["docker-b"])).unwrap(), ["docker-b"]);
    assert!(docker(Some(&[])).unwrap().is_empty());
    let error = docker(Some(&["hosted-c"])).unwrap_err();
    assert!(error.contains("hosted-c"), "{error}");
}

/// A repository whose `examples/scenarios.md` lists `rows`, each an On cell,
/// a deployment ID, and its example's document, with that example written.
fn page(rows: &[(&str, &str, String)]) -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("crates/nemoclaw-e2e/tests/e2e/hcl/tests")).unwrap();
    let mut table = String::from(
        "| On | ID | Scenario | Example | Needs | Model |\n|---|---|---|---|---|---|\n",
    );
    for (on, id, document) in rows {
        let example = format!("platforms/{}.yaml", id.to_lowercase());
        table.push_str(&format!(
            "| {on} | {id} | x | [{example}]({example}) | docker | vLLM |\n"
        ));
        let path = root.path().join("examples").join(&example);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, document).unwrap();
    }
    fs::write(root.path().join("examples/scenarios.md"), table).unwrap();
    root
}

#[test]
fn a_station_row_that_is_on_runs_on_the_station_and_not_the_generic_gpu_runner() {
    let root = page(&[("✅", "STATION-OPENCLAW", document("docker", VLLM))]);
    let placements = nemoclaw_build::hcl_cases::placements(root.path()).unwrap();
    assert_eq!(placements["station-openclaw"].runner, Runner::DgxStation);
    assert!(on(root.path(), Runner::Gpu, None).unwrap().is_empty());
    assert_eq!(
        nemoclaw_build::hcl_cases::files(root.path(), "station-openclaw").unwrap(),
        [
            "examples/platforms/station-openclaw.yaml",
            "crates/nemoclaw-e2e/tests/e2e/hcl/scenarios/lifecycle-model.tftest.hcl",
            "examples/scenarios.md",
        ]
    );
}

#[cfg(unix)]
#[test]
fn a_row_that_links_a_symlinked_example_owns_the_file_it_names() {
    let root = page(&[("✅", "STATION-OPENCLAW", document("docker", VLLM))]);
    let linked = root.path().join("examples/platforms/station-openclaw.yaml");
    let target = root
        .path()
        .join("examples/platforms/docker/openclaw-dgx-station.yaml");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::rename(&linked, &target).unwrap();
    std::os::unix::fs::symlink("docker/openclaw-dgx-station.yaml", &linked).unwrap();
    let files = nemoclaw_build::hcl_cases::files(root.path(), "station-openclaw").unwrap();
    assert_eq!(
        files[0],
        "examples/platforms/docker/openclaw-dgx-station.yaml"
    );
    assert!(files.contains(&"examples/platforms/station-openclaw.yaml".to_owned()));
}

#[test]
fn a_spark_row_runs_only_on_the_manual_spark_runner() {
    let root = page(&[("✅", "SPARK-OPENCLAW", document("docker", VLLM))]);
    let ids = vec!["spark-openclaw".to_owned()];
    assert_eq!(on(root.path(), Runner::DgxSpark, Some(&ids)).unwrap(), ids);
    assert!(on(root.path(), Runner::DgxStation, Some(&ids)).is_err());
    assert!(on(root.path(), Runner::Gpu, Some(&ids)).is_err());
}

#[test]
fn a_paused_row_or_one_without_a_ci_runner_is_not_a_live_case() {
    let root = page(&[
        ("⏸️", "STATION-HERMES", document("docker", VLLM)),
        ("✅", "DOCKER-OPENCLAW", document("docker", STUB_KEY)),
    ]);
    assert!(
        nemoclaw_build::hcl_cases::live(root.path())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn station_harnesses_are_independently_selectable_only_on_station() {
    let root = page(&[
        ("✅", "STATION-OPENCLAW", document("docker", VLLM)),
        ("✅", "STATION-HERMES", document("docker", VLLM)),
    ]);
    let hermes = "station-hermes".to_owned();
    let openclaw = "station-openclaw".to_owned();
    for ids in [
        vec![hermes.clone()],
        vec![openclaw.clone()],
        vec![hermes, openclaw],
    ] {
        assert_eq!(
            on(root.path(), Runner::DgxStation, Some(&ids)).unwrap(),
            ids
        );
        assert!(on(root.path(), Runner::Gpu, Some(&ids)).is_err());
    }
    assert!(on(root.path(), Runner::DgxStation, Some(&["unknown".into()])).is_err());
}
