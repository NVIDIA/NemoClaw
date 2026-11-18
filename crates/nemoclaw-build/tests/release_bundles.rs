// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Release staging attaches the CLI bundles that CI / Bundle checked at the
//! tagged commit, run here against a fake GitHub.

use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const VERSION: &str = "v0.1.0-rc11";
const PLATFORMS: [&str; 4] = [
    "linux_arm64",
    "linux_amd64",
    "darwin_arm64",
    "windows_amd64",
];

/// Answers `gh run list` from $FAKE_GITHUB/runs.json, and `gh run download`
/// from $FAKE_GITHUB/RUN/NAME/bundle.tar, the run's unexpired artifacts.
const FAKE_GH: &str = r#"#!/bin/sh
set -eu
case "$1 $2" in
  "run list")
    while [ $# -gt 0 ]; do
      [ "$1" = --jq ] && filter=$2
      shift
    done
    exec jq -r "$filter" "$FAKE_GITHUB/runs.json" ;;
  "run download")
    run=$3
    shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --pattern) pattern=$2 ;;
        --dir) dir=$2 ;;
      esac
      shift
    done
    found=
    for artifact in "$FAKE_GITHUB/$run"/*; do
      name=${artifact##*/}
      case "$name" in
        $pattern) mkdir -p "$dir/$name"; cp "$artifact/bundle.tar" "$dir/$name/"; found=1 ;;
      esac
    done
    [ -n "$found" ] || { echo "no valid artifacts found to download" >&2; exit 1; }
    exit 0 ;;
esac
echo "unexpected gh $*" >&2
exit 2
"#;

struct Github {
    root: tempfile::TempDir,
    runs: Vec<Value>,
}

impl Github {
    fn new() -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
            runs: Vec::new(),
        }
    }

    fn data(&self) -> PathBuf {
        self.root.path().join("github")
    }

    /// A CI / Bundle run at COMMIT whose unexpired artifacts are (name, the
    /// bundled `nemoclaw`'s contents), each holding a bundle as CI packs it.
    fn run(&mut self, id: u64, event: &str, conclusion: &str, artifacts: &[(String, String)]) {
        self.runs.push(json!({
            "databaseId": id,
            "event": event,
            "conclusion": conclusion,
            "url": format!("https://github.com/NVIDIA/NemoClaw/actions/runs/{id}"),
        }));
        for (name, contents) in artifacts {
            let platform = PLATFORMS
                .iter()
                .find(|platform| name.contains(&format!("-{platform}-")))
                .unwrap();
            let directory = self.data().join(id.to_string()).join(name);
            fs::create_dir_all(&directory).unwrap();
            let mut tar =
                tar::Builder::new(fs::File::create(directory.join("bundle.tar")).unwrap());
            for (path, mode, bytes) in [
                (
                    format!("dist/{platform}/bin/nemoclaw"),
                    0o755,
                    contents.as_bytes(),
                ),
                (
                    format!("dist/{platform}/manifest.json"),
                    0o644,
                    b"{}".as_slice(),
                ),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(mode);
                header.set_cksum();
                tar.append_data(&mut header, path, bytes).unwrap();
            }
            tar.finish().unwrap();
        }
    }

    /// Run the stage job's step that downloads the CLI bundles.
    fn stage(&self) -> Output {
        fs::create_dir_all(self.data()).unwrap();
        fs::write(
            self.data().join("runs.json"),
            Value::Array(self.runs.clone()).to_string(),
        )
        .unwrap();
        let bin = self.root.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("gh"), FAKE_GH).unwrap();
        fs::set_permissions(bin.join("gh"), fs::Permissions::from_mode(0o700)).unwrap();
        let temp = self.root.path().join("runner-temp");
        fs::create_dir_all(&temp).unwrap();
        let workflow: Value = serde_saphyr::from_str(
            &fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.github/workflows/release.yml"),
            )
            .unwrap(),
        )
        .unwrap();
        let script = workflow["jobs"]["stage"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|step| step["id"] == "cli")
            .unwrap()["run"]
            .as_str()
            .unwrap()
            .to_owned();
        // GitHub runs a step without a shell setting as `bash -e`.
        Command::new("/bin/bash")
            .args(["--noprofile", "--norc", "-e", "-c", &script])
            .env_clear()
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("FAKE_GITHUB", self.data())
            .env("RUNNER_TEMP", &temp)
            .env("GITHUB_OUTPUT", self.root.path().join("output"))
            .env("GITHUB_REPOSITORY", "NVIDIA/NemoClaw")
            .env("GITHUB_SHA", COMMIT)
            .env("GITHUB_REF_NAME", VERSION)
            .env("GH_TOKEN", "token")
            .current_dir(self.root.path())
            .output()
            .unwrap()
    }

    fn archives(&self) -> PathBuf {
        self.root.path().join("runner-temp/cli-bundles")
    }
}

fn bundles(label: &str, attempt: u32) -> Vec<(String, String)> {
    PLATFORMS
        .iter()
        .map(|platform| {
            (
                format!("bundle-{platform}-{COMMIT}-{attempt}"),
                format!("{label} {platform}"),
            )
        })
        .collect()
}

/// The bundled `nemoclaw`'s contents and mode in a platform's archive.
fn bundled_cli(archives: &Path, platform: &str) -> (String, u32) {
    let archive =
        fs::File::open(archives.join(format!("nemoclaw-{VERSION}-{platform}.tar.gz"))).unwrap();
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    for entry in tar.entries().unwrap() {
        let mut entry = entry.unwrap();
        if entry.path().unwrap() == Path::new(&format!("dist/{platform}/bin/nemoclaw")) {
            let mode = entry.header().mode().unwrap();
            let mut contents = String::new();
            entry.read_to_string(&mut contents).unwrap();
            return (contents, mode);
        }
    }
    panic!("the {platform} archive holds no dist/{platform}/bin/nemoclaw");
}

fn report(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn each_platform_archive_holds_the_bundle_from_the_passing_ci_run_at_the_commit() {
    let mut github = Github::new();
    github.run(12, "pull_request", "success", &bundles("pull request", 1));
    github.run(11, "push", "failure", &bundles("failed run", 1));
    let mut passing = bundles("first attempt", 1);
    passing.extend(bundles("rerun", 2));
    passing.push((
        format!("bundle-part-windows_amd64-{COMMIT}-2-cli"),
        "part".into(),
    ));
    github.run(13, "push", "success", &passing);

    let output = github.stage();
    assert!(output.status.success(), "{}", report(&output));

    let archives = github.archives();
    for platform in PLATFORMS {
        let (contents, mode) = bundled_cli(&archives, platform);
        assert_eq!(
            contents,
            format!("rerun {platform}"),
            "{platform}'s archive holds the passing push run's latest bundle"
        );
        assert_eq!(
            mode & 0o111,
            0o111,
            "{platform}'s nemoclaw stays executable"
        );
    }
    let sums = fs::read_to_string(archives.join("SHA256SUMS")).unwrap();
    assert_eq!(
        sums.lines().count(),
        4,
        "SHA256SUMS lists each archive: {sums}"
    );
    let check = Command::new("sha256sum")
        .args(["--check", "--strict", "SHA256SUMS"])
        .current_dir(&archives)
        .output()
        .unwrap();
    assert!(
        check.status.success(),
        "the checksums verify: {}",
        report(&check)
    );
}

#[test]
fn staging_fails_when_only_a_pull_request_run_passed_at_the_commit() {
    let mut github = Github::new();
    github.run(12, "pull_request", "success", &bundles("pull request", 1));
    github.run(11, "push", "failure", &bundles("failed run", 1));

    let output = github.stage();
    let report = report(&output);
    assert!(!output.status.success(), "staging fails: {report}");
    assert!(
        report.contains("::error::") && report.contains(COMMIT),
        "the error names the commit: {report}"
    );
    assert!(
        !github.archives().join("SHA256SUMS").exists(),
        "nothing is staged"
    );
}

#[test]
fn staging_fails_naming_each_platform_whose_checked_bundle_expired() {
    let mut github = Github::new();
    let mut artifacts = bundles("checked", 1);
    // gh run download skips expired artifacts.
    artifacts.remove(1);
    github.run(13, "push", "success", &artifacts);

    let output = github.stage();
    let report = report(&output);
    assert!(!output.status.success(), "staging fails: {report}");
    let error = report
        .lines()
        .find(|line| line.starts_with("::error::"))
        .unwrap_or_else(|| panic!("no error annotation: {report}"));
    assert!(
        error.contains("linux_amd64"),
        "the error names the platform: {error}"
    );
    assert!(
        !error.contains("linux_arm64"),
        "only the missing platform: {error}"
    );
}
