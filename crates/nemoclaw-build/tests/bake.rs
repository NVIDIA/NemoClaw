// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The Bake file's public build interface, checked without building anything.
//!
//! Each test asks Bake to print its plan. Without Docker Buildx the tests
//! report that and pass, so hosts without Docker can still run the workspace.

use serde_json::Value;
use std::{collections::BTreeSet, path::Path, process::Command};

const HARNESSES: [&str; 10] = [
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
];
const AMD64_HARNESSES: [&str; 2] = ["deepagents", "openclaw"];

/// Whether Docker Buildx can run here; the Windows and macOS runners lack it.
fn buildx_available() -> bool {
    Command::new("docker")
        .args(["buildx", "version"])
        .output()
        .is_ok_and(|output| output.status.success())
}

fn bake(platform: Option<&str>, targets: &[&str]) -> Option<std::process::Output> {
    if !buildx_available() {
        eprintln!("skipping: docker buildx is unavailable");
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
fn amd64_builds_only_its_qualified_harnesses() {
    let Some(targets) = plan("linux/amd64", &["agents"]) else {
        return;
    };
    assert_eq!(names(&targets), BTreeSet::from(AMD64_HARNESSES));
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

#[test]
fn the_proxy_image_holds_only_its_rust_binary() {
    let dockerfile = include_str!("../../../image/ollama-proxy/Dockerfile");
    assert!(dockerfile.contains("FROM scratch AS runtime"));
    assert!(dockerfile.contains(r#"ENTRYPOINT ["/usr/local/bin/nemoclaw-ollama-proxy"]"#));
    assert!(!dockerfile.to_lowercase().contains("python"));
}

#[test]
fn builds_require_an_explicit_platform() {
    let Some(output) = bake(None, &["agents"]) else {
        return;
    };
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("AGENT_PLATFORM"));
}
