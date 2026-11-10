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

/// Runs `images build --platform linux/arm64 ARGS openclaw` against a fake
/// Docker that plans one target, exports an empty catalog, and records each
/// build's `--set` overrides. Returns the catalog build's, then the labeled build's.
#[cfg(unix)]
fn build_overrides(args: &[&str]) -> [Vec<String>; 2] {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let docker = bin.join("docker");
    fs::write(
        &docker,
        r#"#!/bin/sh
[ "$1 $2" = "buildx bake" ] || exit 90
shift 2
case " $* " in
  *" --print "*) printf '%s\n' '{"target":{"openclaw":{"tags":["nc-fabric:openclaw"]}}}'; exit 0 ;;
esac
line=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --set ]; then
    case "$2" in
      openclaw.output=type=local,dest=*) mkdir -p "${2#*dest=}"; printf '{"adapters":[]}' > "${2#*dest=}/catalog.json" ;;
    esac
    line="$line$2	"
    shift
  fi
  shift
done
printf '%s\n' "$line" >> builds
"#,
    )
    .unwrap();
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .args(["images", "build", "--platform", "linux/arm64"])
        .args(args)
        .arg("openclaw")
        .current_dir(root.path())
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let builds: Vec<Vec<String>> = fs::read_to_string(root.path().join("builds"))
        .unwrap()
        .lines()
        .map(|line| {
            line.split('\t')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .collect();
    builds
        .try_into()
        .expect("a catalog build, then a labeled build")
}

/// The attributes of each `openclaw.KEY=type=...,ATTR=VALUE` override.
#[cfg(unix)]
fn cache_entries(
    overrides: &[String],
    key: &str,
) -> Vec<std::collections::BTreeMap<String, String>> {
    overrides
        .iter()
        .filter_map(|o| o.strip_prefix(&format!("openclaw.{key}=")))
        .map(|entry| {
            entry
                .split(',')
                .filter_map(|pair| pair.split_once('='))
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .collect()
        })
        .collect()
}

#[cfg(unix)]
#[test]
fn a_gha_cache_build_imports_each_targets_layers_and_saves_them_only_when_asked() {
    for save in [false, true] {
        let mut args = vec!["--gha-cache", "live"];
        if save {
            args.push("--save-gha-cache");
        }
        let [catalog, labeled] = build_overrides(&args);
        for overrides in [&catalog, &labeled] {
            let imports = cache_entries(overrides, "cache-from");
            assert_eq!(
                imports.len(),
                1,
                "each build imports one cache: {overrides:?}"
            );
            assert_eq!(imports[0]["type"], "gha");
            // Each target and platform keeps its own entry, so builds don't overwrite each other's.
            assert_eq!(imports[0]["scope"], "live-openclaw-arm64");
        }
        // The labeled build runs every stage the image needs, so it alone saves them.
        assert!(
            cache_entries(&catalog, "cache-to").is_empty(),
            "{catalog:?}"
        );
        let exports = cache_entries(&labeled, "cache-to");
        if save {
            assert_eq!(exports.len(), 1, "{labeled:?}");
            assert_eq!(exports[0]["type"], "gha");
            assert_eq!(exports[0]["scope"], "live-openclaw-arm64");
            // Builder stages, such as the Fabric runtime's Rust build, are most of the time saved.
            assert_eq!(exports[0]["mode"], "max");
            // An unavailable cache service must not fail the build.
            assert_eq!(exports[0]["ignore-error"], "true");
        } else {
            assert!(exports.is_empty(), "{labeled:?}");
        }
    }
}

#[cfg(unix)]
#[test]
fn a_build_without_a_cache_neither_imports_nor_saves_layers() {
    for overrides in build_overrides(&[]) {
        assert!(
            cache_entries(&overrides, "cache-from").is_empty(),
            "{overrides:?}"
        );
        assert!(
            cache_entries(&overrides, "cache-to").is_empty(),
            "{overrides:?}"
        );
    }
}
