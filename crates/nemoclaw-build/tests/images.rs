// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image labels publish exactly the metadata the image itself reports.

use nemoclaw_build::images::{PLATFORMS, labels, plan};
use serde_json::json;
use std::path::Path;

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

/// A Bake file whose `agents` group builds `armonly` only for linux/arm64.
const PLATFORM_BAKE: &str = r#"variable "AGENT_PLATFORM" {
  default = "linux/arm64"
}

group "agents" {
  targets = AGENT_PLATFORM == "linux/amd64" ? ["shared"] : ["armonly", "shared"]
}

target "shared" {
  platforms = [AGENT_PLATFORM]
  tags      = ["fixture/shared:local"]
}

target "armonly" {
  platforms = [AGENT_PLATFORM]
  tags      = ["fixture/armonly:local"]
}

target "reference" {
  platforms = [AGENT_PLATFORM]
  tags      = ["fixture/reference:local"]
}
"#;

#[test]
fn harnesses_missing_from_the_selected_platform_name_the_platforms_that_build_them() {
    // Plans with Bake's print mode only; nothing is built. Agent images are
    // Linux images, planned on Linux hosts as in bake.rs: planning them
    // elsewhere adds no coverage, and buildx is slow on Windows runners.
    if !cfg!(target_os = "linux")
        || !std::process::Command::new("docker")
            .args(["buildx", "version"])
            .output()
            .is_ok_and(|output| output.status.success())
    {
        eprintln!("skipping: agent images are planned only on Linux hosts with docker buildx");
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("docker-bake.hcl"), PLATFORM_BAKE).unwrap();
    let root = directory.path();
    let error = plan(root, "linux/amd64", &["shared".into(), "armonly".into()]).unwrap_err();
    assert_eq!(
        error,
        "armonly is built only for linux/arm64; linux/amd64 builds shared (docs/build.md#build-agent-images)"
    );
    let planned = |platform, name: &str| {
        plan(root, platform, &[name.into()])
            .unwrap()
            .into_iter()
            .map(|(target, _)| target)
            .collect::<Vec<_>>()
    };
    assert_eq!(planned("linux/amd64", "shared"), ["shared"]);
    assert_eq!(planned("linux/arm64", "armonly"), ["armonly"]);
    // Selections that are not harnesses keep Bake's own resolution.
    assert_eq!(planned("linux/amd64", "reference"), ["reference"]);
    assert!(plan(root, "linux/amd64", &["no-such-target".into()]).is_err());
}
