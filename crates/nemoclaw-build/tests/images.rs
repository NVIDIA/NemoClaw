// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image labels publish exactly the metadata the image itself reports.

use nemoclaw_build::images::{PLATFORMS, labels, plan};
use serde_json::json;
use std::{fs, path::Path, process::Command};

#[test]
fn harness_images_carry_their_catalog() {
    let catalog = json!({"adapters": [{"descriptor": {"adapter_id": "nvidia.fabric.pi"}}]});
    assert_eq!(
        labels("pi", catalog.clone()).unwrap(),
        [("io.nemoclaw.fabric.catalog".to_owned(), catalog.to_string())]
    );
    // Only the reference image may publish the reference adapter.
    let impostor = json!({"adapters": [{"descriptor": {"adapter_id": "org.nemoclaw.dummy"}}]});
    assert!(labels("pi", impostor).is_err());
}

#[test]
fn the_reference_image_carries_a_catalog_so_deployments_can_select_it() {
    let catalog = json!({"adapters": [{"descriptor": {"adapter_id": "org.nemoclaw.dummy"}}]});
    assert_eq!(
        labels("dummy", catalog.clone()).unwrap(),
        [("io.nemoclaw.fabric.catalog".to_owned(), catalog.to_string())]
    );
    // The reference image lists only the reference adapter.
    let production = json!({"adapters": [{"descriptor": {"adapter_id": "nvidia.fabric.pi"}}]});
    assert!(labels("dummy", production).is_err());
    assert!(labels("dummy", json!({"adapters": []})).is_err());
}

#[test]
fn builds_require_one_of_the_qualified_platforms() {
    // Rejected before Docker runs, so this needs no daemon.
    let error = plan(Path::new("."), "linux/riscv64", &["agents".into()]).unwrap_err();
    assert!(error.contains("--platform"), "{error}");
    for platform in PLATFORMS {
        assert!(error.contains(platform), "{error}");
    }
}

/// Live / HCL builds each live HCL case's runtime images from this list.
#[test]
fn ci_lists_the_runtime_images_each_live_case_runs() {
    let root = tempfile::tempdir().unwrap();
    let write = |path: &str, contents: &str| {
        let path = root.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    };
    let serving = |kind: &str| {
        format!("kind: NemoClawConfig\nspec:\n  services:\n    model:\n      kind: {kind}\n")
    };
    write(
        "crates/nemoclaw-e2e/cases/docker-vllm.yaml",
        &serving("vllm"),
    );
    write(
        "crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-vllm.tftest.hcl",
        "\n",
    );
    write(
        "crates/nemoclaw-e2e/cases/docker-hosted.yaml",
        "kind: NemoClawConfig\n",
    );
    write(
        "crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-hosted.tftest.hcl",
        "\n",
    );
    // A case document that no live scenario deploys.
    write(
        "crates/nemoclaw-e2e/cases/docker-ollama.yaml",
        &serving("ollama"),
    );
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .args(["images", "runtimes"])
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let runtimes: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        runtimes,
        json!({"docker-hosted": [], "docker-vllm": ["vllm"]})
    );
}
