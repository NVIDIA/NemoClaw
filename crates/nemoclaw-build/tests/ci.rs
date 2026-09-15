// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
fn native_cache_reuses_compatible_builds_without_restoring_bundles_or_credentials() {
    let workflow: serde_json::Value =
        serde_saphyr::from_str(include_str!("../../../.github/workflows/rust.yml")).unwrap();
    let steps = workflow["jobs"]["native"]["steps"].as_array().unwrap();
    let cache = steps
        .iter()
        .find(|step| {
            step["uses"]
                .as_str()
                .is_some_and(|action| action.starts_with("actions/cache@"))
        })
        .expect("native builds must restore a cache before compiling");
    let inputs = &cache["with"];
    let paths: Vec<_> = inputs["path"].as_str().unwrap().lines().collect();
    assert_eq!(
        paths,
        [
            "~/.cargo/registry",
            "~/.cargo/git",
            "target",
            ".build/downloads"
        ]
    );
    let key = inputs["key"].as_str().unwrap();
    let prefix = inputs["restore-keys"].as_str().unwrap().trim();
    assert!(key.starts_with(prefix));
    assert!(key.ends_with("${{ github.sha }}"));
    for input in [
        "matrix.platform",
        "rust-toolchain.toml",
        "Cargo.lock",
        "Cargo.toml",
    ] {
        assert!(
            prefix.contains(input),
            "cache compatibility must include {input}"
        );
    }
    let cache_index = steps.iter().position(|step| step == cache).unwrap();
    let compile_index = steps
        .iter()
        .position(|step| {
            step["run"]
                .as_str()
                .is_some_and(|script| script.contains("cargo clippy"))
        })
        .unwrap();
    assert!(cache_index < compile_index);
}
