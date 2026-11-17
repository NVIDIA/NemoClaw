// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! How the Bake file treats its inputs, checked without building anything.
//!
//! Building the images is CI / Images' job; these tests cover what a build
//! would not reveal. Without Docker Buildx the Bake test reports that and
//! passes, so hosts without Docker can still run the workspace.

use serde_json::Value;
use std::{collections::BTreeSet, path::Path, process::Command};

/// Whether Docker Buildx can run here; the Windows and macOS runners lack it.
fn buildx_available() -> bool {
    // Agent images are Linux images, built on Linux hosts; planning them
    // elsewhere adds no coverage, and buildx is slow on Windows runners.
    if !cfg!(target_os = "linux") {
        return false;
    }
    Command::new("docker")
        .args(["buildx", "version"])
        .output()
        .is_ok_and(|output| output.status.success())
}

fn bake(platform: Option<&str>, targets: &[&str]) -> Option<std::process::Output> {
    if !buildx_available() {
        eprintln!("skipping: agent images are planned only on Linux hosts with docker buildx");
        return None;
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("docker");
    command
        .current_dir(root)
        .args(["buildx", "bake", "--print"])
        .args(targets)
        .env_remove("AGENT_PLATFORM")
        .env_remove("IMAGE_PREFIX");
    if let Some(platform) = platform {
        command.env("AGENT_PLATFORM", platform);
    }
    Some(command.output().expect("docker runs after buildx answered"))
}

/// The host's platform, as Bake names it without a CPU variant.
fn host_platform() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "linux/arm64"
    } else {
        "linux/amd64"
    }
}

fn platforms(target: &Value) -> Vec<String> {
    target["platforms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|platform| {
            platform
                .as_str()
                .unwrap()
                .trim_end_matches("/v8")
                .to_owned()
        })
        .collect()
}

#[test]
fn agent_builds_default_to_the_host_platform_and_reject_others() {
    let Some(output) = bake(None, &["dummy"]) else {
        return;
    };
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(platforms(&plan["target"]["dummy"]), [host_platform()]);
    let rejected = bake(Some("linux/riscv64"), &["dummy"]).unwrap();
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("AGENT_PLATFORM"));
}

/// Image builds copy remote files only from the sources that versions.json
/// pins, which `cargo images fetch` downloads and checks, so BuildKit
/// downloads nothing itself.
#[test]
fn image_builds_copy_remote_files_only_from_their_pinned_sources() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let pins = nemoclaw_build::images::source_pins(&root).unwrap();
    let mut copying = BTreeSet::new();
    for entry in std::fs::read_dir(root.join("image")).unwrap() {
        let directory = entry.unwrap().path();
        let Ok(dockerfile) = std::fs::read_to_string(directory.join("Dockerfile")) else {
            continue;
        };
        let image = directory.file_name().unwrap().to_str().unwrap().to_owned();
        let instructions = dockerfile.replace("\\\n", " ");
        for instruction in instructions.lines().map(str::trim) {
            assert!(
                !(instruction.starts_with("ADD ") && instruction.contains("://")),
                "image/{image}/Dockerfile downloads a file; pin it in versions.json: {instruction}"
            );
            let Some(arguments) = instruction.strip_prefix("COPY --from=sources ") else {
                continue;
            };
            let paths: Vec<&str> = arguments
                .split_whitespace()
                .filter(|argument| !argument.starts_with("--"))
                .collect();
            for source in &paths[..paths.len() - 1] {
                let name = source.trim_start_matches('/');
                assert!(
                    pins.get(&image)
                        .is_some_and(|files| files.contains_key(name)),
                    "image/{image}/Dockerfile copies {name}, which imageSources.{image} doesn't pin"
                );
            }
            copying.insert(image.clone());
        }
    }
    assert_eq!(
        copying,
        pins.keys().cloned().collect(),
        "every image with pinned sources copies them"
    );
}
