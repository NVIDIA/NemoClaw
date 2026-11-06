// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Each live HCL case runs where its document's needs are met.

use nemoclaw_build::hcl_cases::{Runner, needs, on};
use std::fs;

/// A case document from its gateway runtime provider and extra `spec` YAML.
fn document(provider: &str, spec: &str) -> String {
    format!(
        "kind: NemoClawConfig\nspec:\n  gateway:\n    runtime:\n      provider: {provider}\n{spec}"
    )
}

const NVIDIA_KEY: &str = "  inferenceProviders:\n    nvidia:\n      provider: openai\n      credential:\n        env: NVIDIA_INFERENCE_API_KEY\n";
const VLLM: &str = "  services:\n    model:\n      kind: vllm\n";
const STUB_KEY: &str = "  inferenceProviders:\n    stub:\n      provider: openai\n      credential:\n        env: NEMOCLAW_TEST_STUB_KEY\n";

#[test]
fn kubernetes_and_openshift_gateways_run_on_the_kind_cluster() {
    for provider in ["kubernetes", "openshift"] {
        let needed = needs(&document(provider, NVIDIA_KEY)).unwrap();
        assert_eq!(needed.runner, Runner::LiveKind, "{provider}");
    }
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
