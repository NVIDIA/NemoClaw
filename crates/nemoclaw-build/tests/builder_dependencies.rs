// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
//! The CI runner builds `nemoclaw-build` without default features before it
//! installs anything, so that build must not pull in the SDK or transports.
use std::process::Command;

#[test]
fn ci_builder_dependency_closure_excludes_sdk_and_provider_transports() {
    let output = Command::new(env!("CARGO"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "tree",
            "--locked",
            "--offline",
            "--package",
            "nemoclaw-build",
            "--no-default-features",
            "--edges",
            "normal",
            "--prefix",
            "none",
            "--format",
            "{p}",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let tree = String::from_utf8(output.stdout).unwrap();
    // Each line is "NAME vVERSION (SOURCE)"; local sources print the checkout
    // path, which must not count as a dependency name.
    let packages: Vec<&str> = tree
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .collect();
    assert!(packages.contains(&"nemoclaw-build"), "{tree}");
    for name in [
        "nemoclaw-sdk",
        "nemoclaw-provider",
        "openshell",
        "nemo-fabric",
        "bollard",
        "tonic",
    ] {
        let included: Vec<_> = packages
            .iter()
            .filter(|package| package.contains(name))
            .collect();
        assert!(included.is_empty(), "the CI builder includes {included:?}");
    }
}
