// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Release staging packages the CLI bundles that CI / Bundle checked at the
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

/// Answers the GitHub API and `gh run download` from files under
/// $FAKE_GITHUB: runs.json, artifacts-RUN.json, and RUN/NAME/bundle.tar.
const FAKE_GH: &str = r#"#!/bin/sh
set -eu
if [ "$1" = run ] && [ "$2" = download ]; then
  run=$3
  shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name=$2; shift 2 ;;
      --dir) dir=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  test -f "$FAKE_GITHUB/$run/$name/bundle.tar" || { echo "no artifact $name in run $run" >&2; exit 1; }
  mkdir -p "$dir"
  cp "$FAKE_GITHUB/$run/$name/bundle.tar" "$dir/"
  exit 0
fi
[ "$1" = api ] || { echo "unexpected gh $*" >&2; exit 2; }
for argument in "$@"; do
  case "$argument" in
    repos/NVIDIA/NemoClaw/actions/workflows/rust.yml/runs\?*) exec cat "$FAKE_GITHUB/runs.json" ;;
    repos/NVIDIA/NemoClaw/actions/runs/*/artifacts*)
      run=${argument#repos/NVIDIA/NemoClaw/actions/runs/}
      exec cat "$FAKE_GITHUB/artifacts-${run%%/*}.json" ;;
  esac
done
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

    /// A CI / Bundle run at COMMIT whose artifacts are (name, expired, the
    /// bundled `nemoclaw`'s contents); bundle artifacts hold a bundle.
    fn run(
        &mut self,
        id: u64,
        event: &str,
        conclusion: &str,
        artifacts: &[(String, bool, String)],
    ) {
        self.runs.push(json!({
            "id": id,
            "event": event,
            "head_sha": COMMIT,
            "status": "completed",
            "conclusion": conclusion,
            "html_url": format!("https://github.com/NVIDIA/NemoClaw/actions/runs/{id}"),
        }));
        let mut listed = Vec::new();
        for (name, expired, contents) in artifacts {
            listed.push(json!({"name": name, "expired": expired}));
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
        fs::create_dir_all(self.data()).unwrap();
        fs::write(
            self.data().join(format!("artifacts-{id}.json")),
            json!({"total_count": listed.len(), "artifacts": listed}).to_string(),
        )
        .unwrap();
    }

    /// Run the workflow's packaging step for COMMIT.
    fn package(&self) -> Output {
        fs::create_dir_all(self.data()).unwrap();
        fs::write(
            self.data().join("runs.json"),
            json!({"total_count": self.runs.len(), "workflow_runs": self.runs}).to_string(),
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
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../.github/workflows/release-bundles.yml"),
            )
            .unwrap(),
        )
        .unwrap();
        let script = workflow["jobs"]["bundles"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|step| step["id"] == "package")
            .unwrap()["run"]
            .as_str()
            .unwrap()
            .to_owned();
        Command::new("/bin/bash")
            .args(["--noprofile", "--norc", "-eo", "pipefail", "-c", &script])
            .env_clear()
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("FAKE_GITHUB", self.data())
            .env("RUNNER_TEMP", &temp)
            .env("GITHUB_OUTPUT", self.root.path().join("output"))
            .env("GITHUB_STEP_SUMMARY", self.root.path().join("summary"))
            .env("GITHUB_REPOSITORY", "NVIDIA/NemoClaw")
            .env("GITHUB_RUN_ATTEMPT", "3")
            .env("GH_TOKEN", "token")
            .env("COMMIT", COMMIT)
            .env("VERSION", VERSION)
            .current_dir(self.root.path())
            .output()
            .unwrap()
    }

    fn archives(&self) -> PathBuf {
        self.root.path().join("runner-temp/cli-bundles")
    }
}

fn bundles(label: &str, attempt: u32) -> Vec<(String, bool, String)> {
    PLATFORMS
        .iter()
        .map(|platform| {
            (
                format!("bundle-{platform}-{COMMIT}-{attempt}"),
                false,
                format!("{label} {platform}"),
            )
        })
        .collect()
}

/// The bundled `nemoclaw`'s contents and mode in a platform's archive.
fn bundled_cli(archives: &Path, platform: &str) -> (String, u32) {
    let root = format!("nemoclaw-{VERSION}-{platform}");
    let mut contents = String::new();
    if platform.starts_with("windows") {
        let mut zip =
            zip::ZipArchive::new(fs::File::open(archives.join(format!("{root}.zip"))).unwrap())
                .unwrap();
        let mut file = zip.by_name(&format!("{root}/bin/nemoclaw")).unwrap();
        file.read_to_string(&mut contents).unwrap();
        return (contents, 0);
    }
    let archive = fs::File::open(archives.join(format!("{root}.tar.gz"))).unwrap();
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    for entry in tar.entries().unwrap() {
        let mut entry = entry.unwrap();
        if entry.path().unwrap() == Path::new(&root).join("bin/nemoclaw") {
            let mode = entry.header().mode().unwrap();
            entry.read_to_string(&mut contents).unwrap();
            return (contents, mode);
        }
    }
    panic!("{root} holds no bin/nemoclaw");
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
        false,
        "part".into(),
    ));
    github.run(13, "push", "success", &passing);

    let output = github.package();
    assert!(output.status.success(), "{}", report(&output));

    let archives = github.archives();
    for platform in PLATFORMS {
        let (contents, mode) = bundled_cli(&archives, platform);
        assert_eq!(
            contents,
            format!("rerun {platform}"),
            "{platform}'s archive holds the passing push run's latest bundle"
        );
        if !platform.starts_with("windows") {
            assert_eq!(
                mode & 0o111,
                0o111,
                "{platform}'s nemoclaw stays executable"
            );
        }
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

    let output = github.package();
    let report = report(&output);
    assert!(!output.status.success(), "packaging fails: {report}");
    assert!(
        report.contains("::error::") && report.contains(COMMIT),
        "the error names the commit: {report}"
    );
    assert!(
        !github.archives().join("SHA256SUMS").exists(),
        "nothing is packaged"
    );
}

#[test]
fn staging_fails_naming_each_platform_whose_checked_bundle_expired() {
    let mut github = Github::new();
    let mut artifacts = bundles("checked", 1);
    artifacts[1].1 = true;
    github.run(13, "push", "success", &artifacts);

    let output = github.package();
    let report = report(&output);
    assert!(!output.status.success(), "packaging fails: {report}");
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
