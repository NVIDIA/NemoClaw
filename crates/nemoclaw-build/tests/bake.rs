// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The Bake file's public build interface, checked without building anything.
//!
//! Each test asks Bake to print its plan. Without Docker Buildx the tests
//! report that and pass, so hosts without Docker can still run the workspace.

use serde_json::Value;
use std::{collections::BTreeSet, path::Path, process::Command};

const HARNESSES: [&str; 11] = [
    "deepagents",
    "hermes",
    "openclaw",
    "claude",
    "codex",
    "mini-swe-agent",
    "nooa",
    "nooa-bench",
    "remote-agent",
    "pi",
    "opencode",
];

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

fn plan(platform: &str, targets: &[&str]) -> Option<serde_json::Map<String, Value>> {
    let output = bake(Some(platform), targets)?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
    Some(plan["target"].as_object().unwrap().clone())
}

fn names(targets: &serde_json::Map<String, Value>) -> BTreeSet<&str> {
    targets.keys().map(String::as_str).collect()
}

#[test]
fn arm64_builds_every_harness_locally_for_its_platform() {
    let Some(targets) = plan("linux/arm64", &["agents"]) else {
        return;
    };
    assert_eq!(names(&targets), BTreeSet::from(HARNESSES));
    for (name, target) in &targets {
        assert_eq!(target["args"]["HARNESS"], name.as_str());
        assert_eq!(target["platforms"], serde_json::json!(["linux/arm64"]));
        assert!(!target["output"].to_string().contains("registry"));
    }
}

#[test]
fn amd64_builds_every_harness() {
    let Some(targets) = plan("linux/amd64", &["agents"]) else {
        return;
    };
    assert_eq!(names(&targets), BTreeSet::from(HARNESSES));
    for target in targets.values() {
        assert_eq!(target["platforms"], serde_json::json!(["linux/amd64"]));
    }
}

#[test]
fn one_harness_builds_alone_for_the_selected_platform() {
    let Some(targets) = plan("linux/arm64", &["pi"]) else {
        return;
    };
    assert_eq!(names(&targets), BTreeSet::from(["pi"]));
    let Some(targets) = plan("linux/amd64", &["deepagents"]) else {
        return;
    };
    assert_eq!(
        targets["deepagents"]["platforms"],
        serde_json::json!(["linux/amd64"])
    );
}

#[test]
fn the_reference_image_is_separate_from_the_agents_on_both_platforms() {
    for platform in ["linux/arm64", "linux/amd64"] {
        let Some(targets) = plan(platform, &["dummy"]) else {
            return;
        };
        assert_eq!(names(&targets), BTreeSet::from(["dummy"]));
        assert_eq!(targets["dummy"]["target"], "dummy");
        assert_eq!(targets["dummy"]["platforms"], serde_json::json!([platform]));
        assert_eq!(
            targets["dummy"]["tags"],
            serde_json::json!(["nc-fabric:dummy"])
        );
        let agents = plan(platform, &["agents"]).unwrap();
        assert!(!agents.contains_key("dummy"));
    }
}

#[test]
fn image_checks_include_the_reference_contract() {
    let Some(targets) = plan("linux/arm64", &["check"]) else {
        return;
    };
    assert!(targets.contains_key("reference-tests"));
}

#[test]
fn the_proxy_builds_alone_with_its_tests_on_the_selected_platform() {
    let Some(targets) = plan("linux/arm64", &["ollama-proxy"]) else {
        return;
    };
    assert_eq!(names(&targets), BTreeSet::from(["ollama-proxy"]));
    for platform in ["linux/arm64", "linux/amd64"] {
        let targets = plan(platform, &["ollama-proxy", "proxy-tests"]).unwrap();
        for target in targets.values() {
            assert_eq!(target["platforms"], serde_json::json!([platform]));
        }
    }
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

#[test]
fn runtime_images_build_only_for_the_host_with_their_supervisor() {
    // Selecting the other agent platform doesn't move runtime images off the host.
    let other = if host_platform() == "linux/arm64" {
        "linux/amd64"
    } else {
        "linux/arm64"
    };
    let Some(targets) = plan(other, &["runtimes"]) else {
        return;
    };
    // CI builds a case's runtime images, and `changes cases` selects cases by
    // their files, from this list and directory layout.
    let mut expected = BTreeSet::from(nemoclaw_build::images::RUNTIMES);
    expected.insert("supervisor");
    assert_eq!(names(&targets), expected);
    for (name, target) in &targets {
        assert_eq!(platforms(target), [host_platform()], "{name}");
    }
    assert_eq!(
        targets["supervisor"]["dockerfile"],
        format!("{}/Dockerfile", nemoclaw_build::images::RUNTIME_SUPERVISOR)
    );
    for name in nemoclaw_build::images::RUNTIMES {
        assert_eq!(
            targets[name]["dockerfile"],
            format!("image/{name}/Dockerfile")
        );
        assert_eq!(targets[name]["contexts"]["supervisor"], "target:supervisor");
        let output = &targets[name]["output"][0];
        assert_eq!(output["rewrite-timestamp"], "true", "{name}: {output}");
    }
}

/// Image builds copy remote files only from the sources that versions.json
/// pins, which `cargo images fetch` downloads and checks, so BuildKit
/// downloads nothing itself, and Bake passes each image its own sources.
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
    let Some(targets) = plan(host_platform(), &["agents", "dummy", "check", "runtimes"]) else {
        return;
    };
    for (name, target) in &targets {
        let dockerfile = target["dockerfile"].as_str().unwrap();
        let image = dockerfile
            .strip_prefix("image/")
            .and_then(|path| path.strip_suffix("/Dockerfile"))
            .unwrap();
        let expected = copying
            .contains(image)
            .then(|| format!("{}/{image}", nemoclaw_build::images::SOURCES));
        assert_eq!(
            target["contexts"]["sources"].as_str(),
            expected.as_deref(),
            "{name}"
        );
    }
}
