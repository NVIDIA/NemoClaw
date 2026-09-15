// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[test]
fn native_actions_use_verified_node24_release_pins() {
    let workflow: serde_json::Value =
        serde_saphyr::from_str(include_str!("../../../.github/workflows/rust.yml")).unwrap();
    // Release tags and action.yml runtimes were verified against upstream.
    // GitHub-owned actions and this rust-cache pin are permitted by repository policy.
    let approved = [
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", // v7.0.1
        "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",    // v6.1.0
        "Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6", // v2.9.2
    ];
    for step in workflow["jobs"]["native"]["steps"].as_array().unwrap() {
        if let Some(action) = step["uses"].as_str() {
            assert!(
                approved.contains(&action),
                "review action release, runtime, and policy: {action}"
            );
        }
    }
}

#[test]
fn verified_downloads_have_an_independent_source_stable_cache() {
    let workflow: serde_json::Value =
        serde_saphyr::from_str(include_str!("../../../.github/workflows/rust.yml")).unwrap();
    let steps = workflow["jobs"]["native"]["steps"].as_array().unwrap();
    let downloads = steps
        .iter()
        .find(|step| step["with"]["path"] == ".build/downloads")
        .expect("verified archives need a separate cache");
    assert!(
        downloads["uses"]
            .as_str()
            .unwrap()
            .starts_with("actions/cache@")
    );
    let key = downloads["with"]["key"].as_str().unwrap();
    assert!(key.contains("matrix.platform"));
    assert!(key.contains("hashFiles('versions.json')"));
    assert!(!key.contains("github.sha") && !key.contains("Cargo.lock"));
    assert!(downloads["with"]["restore-keys"].is_null());
    let deps = steps
        .iter()
        .find(|step| {
            step["uses"]
                .as_str()
                .is_some_and(|action| action.starts_with("Swatinem/rust-cache@"))
        })
        .unwrap();
    assert!(deps["with"]["cache-directories"].is_null());
    let download_index = steps.iter().position(|step| step == downloads).unwrap();
    let bundle_index = steps
        .iter()
        .position(|step| {
            step["run"]
                .as_str()
                .is_some_and(|script| script.contains("bundle --platform"))
        })
        .unwrap();
    assert!(download_index < bundle_index);
}

#[test]
fn native_ci_disables_incremental_without_disabling_debug_symbols() {
    let workflow: serde_json::Value =
        serde_saphyr::from_str(include_str!("../../../.github/workflows/rust.yml")).unwrap();
    let env = workflow["jobs"]["native"]["env"].as_object().unwrap();
    assert_eq!(env.get("CARGO_INCREMENTAL"), Some(&serde_json::json!("0")));
    for name in [
        "CARGO_PROFILE_DEV_DEBUG",
        "CARGO_PROFILE_TEST_DEBUG",
        "RUSTFLAGS",
        "CARGO_ENCODED_RUSTFLAGS",
    ] {
        assert!(
            !env.contains_key(name),
            "CI must preserve the existing debug-symbol settings"
        );
    }
}

#[test]
fn fixture_lifecycles_have_bounded_parallelism_on_every_platform() {
    let workflow: serde_json::Value =
        serde_saphyr::from_str(include_str!("../../../.github/workflows/rust.yml")).unwrap();
    let steps = workflow["jobs"]["native"]["steps"].as_array().unwrap();
    let script = steps
        .iter()
        .filter_map(|step| step["run"].as_str())
        .find(|script| script.contains("--ignored"))
        .unwrap();
    assert!(script.contains("-- --ignored --test-threads=2"));
}

#[test]
fn native_commands_preserve_workspace_features_between_build_and_test() {
    let workflow: serde_json::Value =
        serde_saphyr::from_str(include_str!("../../../.github/workflows/rust.yml")).unwrap();
    let steps = workflow["jobs"]["native"]["steps"].as_array().unwrap();
    for script in steps.iter().filter_map(|step| step["run"].as_str()) {
        for command in script
            .lines()
            .filter_map(|line| line.trim().strip_prefix("cargo "))
        {
            if command.starts_with("fmt ") {
                continue;
            }
            assert!(
                !command.starts_with("run "),
                "run the prebuilt bundle tool directly"
            );
            assert!(
                command.contains("--workspace"),
                "package selection changes dependency features: {command}"
            );
            assert!(command.contains("--locked"));
            if command.starts_with("build ") {
                assert!(
                    command.contains("--all-targets"),
                    "build must include test dependency features"
                );
            }
        }
    }
}

#[test]
fn native_cache_retains_only_dependencies_in_both_build_profiles() {
    let workflow: serde_json::Value =
        serde_saphyr::from_str(include_str!("../../../.github/workflows/rust.yml")).unwrap();
    let steps = workflow["jobs"]["native"]["steps"].as_array().unwrap();
    let cache = steps
        .iter()
        .find(|step| {
            step["uses"]
                .as_str()
                .is_some_and(|action| action.starts_with("Swatinem/rust-cache@"))
        })
        .expect("native builds must prune workspace artifacts before caching");
    // This revision is permitted by the repository's selected-actions policy.
    assert_eq!(
        cache["uses"],
        "Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6"
    );
    let inputs = &cache["with"];
    assert_eq!(inputs["cache-all-crates"], "false");
    assert_eq!(inputs["cache-workspace-crates"], "false");
    assert_eq!(inputs["cache-bin"], "false");
    assert_eq!(inputs["cache-targets"], "true");
    // Include debug and target-triple/release artifacts, not just one profile.
    assert_eq!(inputs["workspaces"], ". -> target");
    assert_eq!(inputs["key"], "${{ matrix.platform }}");
    assert_eq!(inputs["add-rust-environment-hash-key"], "true");
    assert!(!inputs.to_string().contains("github.sha"));
    let cache_index = steps.iter().position(|step| step == cache).unwrap();
    let toolchain_index = steps
        .iter()
        .position(|step| {
            step["run"]
                .as_str()
                .is_some_and(|script| script.contains("rustup show"))
        })
        .unwrap();
    let compile_index = steps
        .iter()
        .position(|step| {
            step["run"]
                .as_str()
                .is_some_and(|script| script.contains("cargo clippy"))
        })
        .unwrap();
    assert!(toolchain_index < cache_index && cache_index < compile_index);
}
