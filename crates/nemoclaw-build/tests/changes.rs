// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Whether a change can affect `CI / Images`, decided from a real Git history and
//! Cargo workspace without network access.

use std::{fs, path::Path, process::Command};

const RULES: &str = include_str!("../../../.config/determinator-images.toml");

fn manifest(name: &str, dependencies: &str) -> String {
    format!(
        "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\n{dependencies}"
    )
}

fn run(dir: &Path, program: &str, args: &[&str]) -> std::process::Output {
    Command::new(program)
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", dir)
        .output()
        .unwrap()
}

fn succeed(dir: &Path, program: &str, args: &[&str]) -> String {
    let output = run(dir, program, args);
    assert!(
        output.status.success(),
        "{program} {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn cargo() -> String {
    std::env::var("CARGO").unwrap_or_else(|_| "cargo".into())
}

/// A committed workspace shaped like this repository's image build: the build tool
/// reaches the SDK only through its default feature, and the proxy uses the runtime.
struct Repo(tempfile::TempDir);

impl Repo {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let build = manifest(
            "nemoclaw-build",
            "nemoclaw-runtime = { path = \"../nemoclaw-runtime\" }\nnemoclaw-sdk = { path = \"../nemoclaw-sdk\", optional = true }\n\n[features]\ndefault = [\"sdk\"]\nsdk = [\"dep:nemoclaw-sdk\"]\n",
        );
        let files = [
            (
                "Cargo.toml",
                "[workspace]\nmembers = [\"crates/*\"]\nresolver = \"2\"\n".to_owned(),
            ),
            ("crates/nemoclaw-build/Cargo.toml", build),
            (
                "crates/nemoclaw-ollama-proxy/Cargo.toml",
                manifest(
                    "nemoclaw-ollama-proxy",
                    "nemoclaw-runtime = { path = \"../nemoclaw-runtime\" }\n",
                ),
            ),
            (
                "crates/nemoclaw-runtime/Cargo.toml",
                manifest("nemoclaw-runtime", ""),
            ),
            (
                "crates/nemoclaw-sdk/Cargo.toml",
                manifest("nemoclaw-sdk", ""),
            ),
            ("crates/nemoclaw-sdk/src/extra.rs", String::new()),
            (
                "crates/nemoclaw-e2e/Cargo.toml",
                manifest(
                    "nemoclaw-e2e",
                    "nemoclaw-sdk = { path = \"../nemoclaw-sdk\" }\n",
                ),
            ),
            (".config/determinator-images.toml", RULES.to_owned()),
            (".dockerignore", "*\n".into()),
            (".github/workflows/images.yml", "name: images\n".into()),
            (".github/workflows/rust.yml", "name: rust\n".into()),
            ("LICENSE", "license\n".into()),
            ("docker-bake.hcl", "\n".into()),
            ("docs/guide.md", "# Guide\n".into()),
            ("image/fabric/Dockerfile", "FROM scratch\n".into()),
            ("ruff.toml", "\n".into()),
            ("runtimes/vllm/build.json", "{}\n".into()),
            (
                "rust-toolchain.toml",
                "[toolchain]\nchannel = \"1.98.1\"\n".into(),
            ),
        ];
        for (path, contents) in files {
            write(dir.path(), path, &contents);
        }
        for name in ["build", "ollama-proxy", "runtime", "sdk", "e2e"] {
            write(
                dir.path(),
                &format!("crates/nemoclaw-{name}/src/lib.rs"),
                "",
            );
        }
        succeed(dir.path(), &cargo(), &["generate-lockfile", "--offline"]);
        succeed(dir.path(), "git", &["init", "-q"]);
        succeed(dir.path(), "git", &["add", "-A"]);
        succeed(dir.path(), "git", &["commit", "-q", "-m", "base"]);
        Self(dir)
    }

    fn base(&self) -> String {
        succeed(self.0.path(), "git", &["rev-parse", "HEAD"])
            .trim()
            .to_owned()
    }

    /// Commit the edits (None deletes a file), then ask about the base commit.
    fn decide(&self, edits: &[(&str, Option<&str>)], base: Option<&str>) -> (String, String) {
        let recorded = self.base();
        for (path, contents) in edits {
            match contents {
                Some(contents) => write(self.0.path(), path, contents),
                None => fs::remove_file(self.0.path().join(path)).unwrap(),
            }
        }
        succeed(self.0.path(), "git", &["add", "-A"]);
        succeed(self.0.path(), "git", &["commit", "-q", "-m", "change"]);
        let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
            .args(["changes", "images", "--base", base.unwrap_or(&recorded)])
            .current_dir(self.0.path())
            .env("CARGO", cargo())
            .env("CARGO_NET_OFFLINE", "true")
            .env("HOME", self.0.path())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(output.status.success(), "{stderr}");
        (
            String::from_utf8(output.stdout).unwrap().trim().to_owned(),
            stderr,
        )
    }
}

fn write(root: &Path, path: &str, contents: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

/// Decide for a valid change, which the analysis must complete rather than fail open.
fn images(edits: &[(&str, Option<&str>)]) -> String {
    let (decision, stderr) = Repo::new().decide(edits, None);
    assert!(!stderr.contains("could not analyze"), "{stderr}");
    decision
}

#[test]
fn documentation_runtimes_and_other_workflows_do_not_rebuild_images() {
    let decision = images(&[
        ("docs/guide.md", Some("# Changed\n")),
        ("runtimes/vllm/build.json", Some("{\"changed\": true}\n")),
        (".github/workflows/rust.yml", Some("name: changed\n")),
    ]);
    assert_eq!(decision, "images=false");
}

#[test]
fn sdk_changes_reach_the_build_tool_only_through_its_disabled_default_feature() {
    let decision = images(&[
        (
            "crates/nemoclaw-sdk/src/lib.rs",
            Some("pub fn changed() {}\n"),
        ),
        ("crates/nemoclaw-sdk/src/extra.rs", None),
        (
            "crates/nemoclaw-e2e/src/lib.rs",
            Some("pub fn changed() {}\n"),
        ),
    ]);
    assert_eq!(decision, "images=false");
}

#[test]
fn crates_in_the_image_build_rebuild_images() {
    for path in [
        "crates/nemoclaw-runtime/src/lib.rs",
        "crates/nemoclaw-build/src/lib.rs",
        "crates/nemoclaw-ollama-proxy/src/lib.rs",
    ] {
        assert_eq!(
            images(&[(path, Some("pub fn changed() {}\n"))]),
            "images=true",
            "{path}"
        );
    }
}

#[test]
fn image_inputs_outside_crates_rebuild_images() {
    for path in [
        "image/fabric/Dockerfile",
        "docker-bake.hcl",
        ".dockerignore",
        "ruff.toml",
        "LICENSE",
        "rust-toolchain.toml",
        ".github/workflows/images.yml",
    ] {
        assert_eq!(
            images(&[(path, Some("# changed\n"))]),
            "images=true",
            "{path}"
        );
    }
}

#[test]
fn unclassified_files_rebuild_images() {
    assert_eq!(images(&[("Makefile", Some("all:\n"))]), "images=true");
}

#[test]
fn an_unanalyzable_change_runs_the_image_checks() {
    let (decision, stderr) = Repo::new().decide(
        &[("docs/guide.md", Some("# Changed\n"))],
        Some("0000000000000000000000000000000000000000"),
    );
    assert_eq!(decision, "images=true");
    assert!(stderr.contains("running the image checks"), "{stderr}");
}
