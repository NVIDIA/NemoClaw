// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The shared Rust setup installs the rustup that versions.json pins on a
//! runner without one, such as a leased Colossus machine, and leaves a runner
//! that has rustup alone.

use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output},
};

use serde_json::Value;
use sha2::{Digest, Sha256};

const STEP: &str = "Install rustup when the runner lacks it";
const URL: &str =
    "https://static.rust-lang.org/rustup/archive/1.29.3/aarch64-unknown-linux-gnu/rustup-init";

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn action() -> Vec<Value> {
    let action: Value = serde_saphyr::from_str(
        &fs::read_to_string(repository().join(".github/actions/setup-rust/action.yml")).unwrap(),
    )
    .unwrap();
    action["runs"]["steps"].as_array().unwrap().clone()
}

fn executable(path: &Path, script: &str) {
    fs::write(path, script).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// A tool from this process's PATH.
fn tool(name: &str) -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("{name} is not on PATH"))
}

/// A runner whose PATH holds only the tools the step uses, a curl that serves
/// a fake rustup-init, and rustup when `rustup` is set.
struct Runner {
    root: tempfile::TempDir,
}

impl Runner {
    fn new(rustup: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = |name: &str| root.path().join(name);
        for directory in ["bin", "log", "home", "temp", "checkout"] {
            fs::create_dir(path(directory)).unwrap();
        }
        for name in ["jq", "sha256sum", "chmod", "cat", "cp", "mkdir"] {
            symlink(tool(name), path("bin").join(name)).unwrap();
        }
        executable(
            &path("bin/curl"),
            "#!/bin/sh\nwhile [ $# -gt 0 ]; do case \"$1\" in -o) out=$2; shift ;; https://*) printf '%s\\n' \"$1\" >> \"$LOG/curl\" ;; esac; shift; done\ncat \"$INSTALLER\" > \"$out\"\n",
        );
        executable(
            &path("rustup"),
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LOG/rustup\"\n",
        );
        executable(
            &path("rustup-init"),
            "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$LOG/rustup-init\"\nmkdir -p \"$CARGO_HOME/bin\"\ncp \"$RUSTUP\" \"$CARGO_HOME/bin/rustup\"\n",
        );
        if rustup {
            fs::copy(path("rustup"), path("bin/rustup")).unwrap();
        }
        Self { root }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    /// Runs the step as GitHub runs a `bash` step, in a checkout whose
    /// versions.json pins the given checksum for linux_arm64's rustup-init.
    fn run(&self, sha256: &str) -> Output {
        let step = action()
            .into_iter()
            .find(|step| step["name"] == STEP)
            .expect("a step that installs rustup");
        assert_eq!(step["shell"], "bash");
        fs::write(self.path("step.sh"), step["run"].as_str().unwrap()).unwrap();
        fs::write(
            self.path("checkout/versions.json"),
            serde_json::json!({
                "platforms": {"linux_arm64": {"rustupInit": {"url": URL, "sha256": sha256}}}
            })
            .to_string(),
        )
        .unwrap();
        Command::new(tool("bash"))
            .args(["--noprofile", "--norc", "-eo", "pipefail"])
            .arg(self.path("step.sh"))
            .current_dir(self.path("checkout"))
            .env_clear()
            .env("PATH", self.path("bin"))
            .env("HOME", self.path("home"))
            .env("CARGO_HOME", self.path("home/.cargo"))
            .env("RUNNER_TEMP", self.path("temp"))
            .env("GITHUB_PATH", self.path("github-path"))
            .env("PLATFORM", "linux_arm64")
            .env("LOG", self.path("log"))
            .env("INSTALLER", self.path("rustup-init"))
            .env("RUSTUP", self.path("rustup"))
            .output()
            .unwrap()
    }

    fn installer_sha256(&self) -> String {
        nemoclaw_build::hex(&Sha256::digest(fs::read(self.path("rustup-init")).unwrap()))
    }

    fn log(&self, name: &str) -> Option<String> {
        fs::read_to_string(self.path("log").join(name)).ok()
    }
}

#[test]
fn a_runner_without_rustup_gets_the_pinned_installer_and_the_toolchain_file_s_toolchain() {
    let runner = Runner::new(false);
    let output = runner.run(&runner.installer_sha256());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        runner.log("curl").as_deref(),
        Some(format!("{URL}\n").as_str())
    );
    assert_eq!(
        runner.log("rustup-init").as_deref(),
        Some("-y --no-modify-path --default-toolchain none\n"),
        "installs for the runner user without changing shell profiles"
    );
    assert_eq!(
        runner.log("rustup").as_deref(),
        Some("toolchain install --no-self-update\n")
    );
    assert_eq!(
        fs::read_to_string(runner.path("github-path")).unwrap(),
        format!("{}\n", runner.path("home/.cargo/bin").display()),
        "later steps find rustup and cargo"
    );
}

#[test]
fn a_runner_with_rustup_is_left_unchanged() {
    let runner = Runner::new(true);
    let output = runner.run(&runner.installer_sha256());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(runner.log("curl"), None);
    assert_eq!(runner.log("rustup"), None);
    assert!(!runner.path("github-path").exists());
}

#[test]
fn an_installer_that_differs_from_the_pin_is_not_run() {
    let runner = Runner::new(false);
    let output = runner.run(&"0".repeat(64));
    assert!(!output.status.success());
    assert_eq!(runner.log("rustup-init"), None);
    assert!(!runner.path("github-path").exists());
}

#[test]
fn rustup_is_installed_before_the_cache_step_runs_rustc() {
    let steps = action();
    let position = |found: &dyn Fn(&Value) -> bool| steps.iter().position(found).unwrap();
    assert!(
        position(&|step| step["name"] == STEP)
            < position(&|step| step["uses"]
                .as_str()
                .is_some_and(|uses| uses.starts_with("Swatinem/rust-cache@")))
    );
}

#[test]
fn each_linux_platform_pins_its_own_rustup_init() {
    let pins: Value =
        serde_json::from_slice(&fs::read(repository().join("versions.json")).unwrap()).unwrap();
    for (platform, target) in [
        ("linux_arm64", "aarch64-unknown-linux-gnu"),
        ("linux_amd64", "x86_64-unknown-linux-gnu"),
    ] {
        let pin = &pins["platforms"][platform]["rustupInit"];
        let url = pin["url"].as_str().unwrap();
        assert!(
            url.starts_with("https://static.rust-lang.org/rustup/archive/"),
            "{url}"
        );
        assert!(url.ends_with(&format!("/{target}/rustup-init")), "{url}");
        assert_eq!(pin["sha256"].as_str().unwrap().len(), 64);
    }
}
