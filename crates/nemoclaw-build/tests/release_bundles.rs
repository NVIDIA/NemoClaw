// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Release staging attaches the CLI bundles that CI / Bundle checked at the
//! tag, with the executables the signing jobs signed, and records the signing
//! evidence. Its scripts run here against a fake GitHub and fake signing tools.

use nemoclaw_sdk::bundle::{self, Bundle, Manifest};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const VERSION: &str = "v0.1.0-rc11";
const FINAL: &str = "v0.1.0";
const PROVIDER_VERSION: &str = "0.1.0";
const PLATFORMS: [&str; 4] = [
    "linux_arm64",
    "linux_amd64",
    "darwin_arm64",
    "windows_amd64",
];

/// Answers `gh run list` from $FAKE_GITHUB/runs.json, newest first, `gh run
/// watch` with the run's conclusion, and a run's artifact list from
/// $FAKE_GITHUB/RUN/artifacts.json.
const FAKE_GH: &str = r#"#!/bin/sh
set -eu
filter=
branch=
endpoint=
command=$1
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) filter=$2; shift ;;
    --branch) branch=$2; shift ;;
    --repo | --workflow | --commit | --json | --interval) shift ;;
    --*) ;;
    *) endpoint="$endpoint $1" ;;
  esac
  shift
done
case "$command$endpoint" in
  "run list")
    jq --arg branch "$branch" '[.[] | select($branch == "" or .headBranch == $branch)]' \
      "$FAKE_GITHUB/runs.json" | jq -r "$filter"
    exit 0 ;;
  "run watch "*)
    jq -e --argjson run "${endpoint##* }" 'any(.[]; .databaseId == $run and .conclusion == "success")' \
      "$FAKE_GITHUB/runs.json" > /dev/null
    exit 0 ;;
  api\ repos/NVIDIA/NemoClaw/actions/runs/*/artifacts*)
    run=$(printf '%s\n' "$endpoint" | sed -n 's|.*actions/runs/\([0-9]*\)/artifacts.*|\1|p')
    exec jq -r "$filter" "$FAKE_GITHUB/$run/artifacts.json" ;;
esac
echo "unexpected gh $command$endpoint" >&2
exit 2
"#;

/// Verifies a file whose contents are "notarized TEAM" against a requirement
/// naming TEAM, as `codesign` verifies a notarized Developer ID signature.
const FAKE_CODESIGN: &str = r#"#!/bin/sh
set -eu
verify= strict= notarization= requirement=
for argument; do
  case "$argument" in
    --verify) verify=1 ;;
    --strict) strict=1 ;;
    --check-notarization) notarization=1 ;;
    -R=*) requirement=${argument#-R=} ;;
  esac
  file=$argument
done
[ -n "$verify" ] && [ -n "$strict" ] && [ -n "$notarization" ] || { echo "unexpected codesign $*" >&2; exit 2; }
team=$(printf '%s\n' "$requirement" | sed -n 's/^notarized and anchor apple generic and certificate leaf\[subject.OU\] = "\(.*\)"$/\1/p')
[ -n "$team" ] || { echo "unexpected requirement $requirement" >&2; exit 2; }
[ "$(cat "$file")" = "notarized $team" ] || { echo "$file: test-requirement: code failed to satisfy specified code requirement(s)" >&2; exit 3; }
"#;

struct Github {
    root: tempfile::TempDir,
    /// The tag the release workflow runs for.
    tag: String,
    /// The RELEASE_UNSIGNED_EXCEPTION repository variable.
    exception: Option<String>,
    runs: Vec<Value>,
    /// Each run's artifacts as GitHub lists them.
    artifacts: BTreeMap<u64, Vec<Value>>,
    next_artifact: u64,
}

impl Github {
    fn new() -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
            tag: VERSION.into(),
            exception: None,
            runs: Vec::new(),
            artifacts: BTreeMap::new(),
            next_artifact: 100,
        }
    }

    fn data(&self) -> PathBuf {
        self.root.path().join("github")
    }

    /// A CI / Bundle run at COMMIT of `branch`, a branch or tag, newer than the
    /// runs before it, whose artifacts are (name, the bundled `nemoclaw`'s
    /// contents), each holding a bundle as CI packs it.
    fn run(
        &mut self,
        id: u64,
        event: &str,
        branch: &str,
        conclusion: &str,
        artifacts: &[(String, String)],
    ) {
        self.runs.insert(
            0,
            json!({
                "databaseId": id,
                "event": event,
                "headBranch": branch,
                "conclusion": conclusion,
                "url": format!("https://github.com/NVIDIA/NemoClaw/actions/runs/{id}"),
            }),
        );
        for (name, contents) in artifacts {
            let platform = PLATFORMS
                .iter()
                .find(|platform| name.contains(&format!("-{platform}-")))
                .unwrap();
            let artifact = self.next_artifact;
            self.next_artifact += 1;
            let directory = self.data().join("artifacts").join(artifact.to_string());
            fs::create_dir_all(&directory).unwrap();
            pack_bundle(platform, contents, &directory.join("bundle.tar"));
            self.artifacts.entry(id).or_default().push(json!({
                "id": artifact,
                "name": name,
                "expired": false,
            }));
        }
    }

    /// Let a run's artifact expire, as CI's retention does.
    fn expire(&mut self, run: u64, name: &str) {
        for artifact in self.artifacts.get_mut(&run).unwrap() {
            if artifact["name"] == name {
                artifact["expired"] = json!(true);
            }
        }
    }

    /// A signing job's uploads: the platform's bundle directory with a signed
    /// file, which artifact transfer leaves without its executable mode, and
    /// the output of its signature check.
    fn sign(&self, platform: &str, file: &str, contents: &str) {
        self.upload(platform, file, contents);
        let mut log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.signed().join(format!("{platform}.verification.txt")))
            .unwrap();
        std::io::Write::write_all(
            &mut log,
            format!("Successfully verified: {file}\n").as_bytes(),
        )
        .unwrap();
    }

    /// A file of the bundle a signing job uploads without signing it.
    fn upload(&self, platform: &str, file: &str, contents: &str) {
        let path = self.signed().join(platform).join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    }

    fn signed(&self) -> PathBuf {
        self.root.path().join("runner-temp/signed")
    }

    fn script(&self, name: &str, arguments: &[&Path]) -> Output {
        let bin = self.root.path().join("bin");
        let build = Path::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
            .parent()
            .unwrap();
        // GitHub runs a step without a shell setting as `bash -e`.
        let mut command = Command::new("/bin/bash");
        command
            .args(["--noprofile", "--norc", "-e"])
            .arg(repository().join(".github/scripts").join(name))
            .args(arguments)
            .env_clear()
            .env(
                "PATH",
                format!("{}:{}:/usr/bin:/bin", bin.display(), build.display()),
            )
            .env("FAKE_GITHUB", self.data())
            .env("RUNNER_TEMP", self.root.path().join("runner-temp"))
            .env("GITHUB_OUTPUT", self.root.path().join("output"))
            .env("GITHUB_REPOSITORY", "NVIDIA/NemoClaw")
            .env("GITHUB_SHA", COMMIT)
            .env("GITHUB_REF_NAME", &self.tag)
            .env("GITHUB_SERVER_URL", "https://github.com")
            .env("GITHUB_RUN_ID", "4242")
            .env("GITHUB_RUN_ATTEMPT", "2")
            .env("GH_TOKEN", "token")
            .current_dir(self.root.path());
        if let Some(exception) = &self.exception {
            command.env("RELEASE_UNSIGNED_EXCEPTION", exception);
        }
        command.output().unwrap()
    }

    /// Run the release's staging of the CLI bundles: find the checked bundles,
    /// download them by ID as the workflow does, pack them with whatever the
    /// signing jobs signed, and record the signing.
    fn stage(&self) -> Output {
        fs::create_dir_all(self.data()).unwrap();
        fs::write(
            self.data().join("runs.json"),
            Value::Array(self.runs.clone()).to_string(),
        )
        .unwrap();
        for (run, artifacts) in &self.artifacts {
            fs::create_dir_all(self.data().join(run.to_string())).unwrap();
            fs::write(
                self.data().join(run.to_string()).join("artifacts.json"),
                json!({ "total_count": artifacts.len(), "artifacts": artifacts }).to_string(),
            )
            .unwrap();
        }
        let bin = self.root.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("gh"), FAKE_GH).unwrap();
        fs::set_permissions(bin.join("gh"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(self.root.path().join("runner-temp")).unwrap();
        let found = self.script("find-cli-bundles.sh", &[]);
        if !found.status.success() {
            return found;
        }
        // actions/download-artifact puts each artifact in a directory named after it.
        let outputs = fs::read_to_string(self.root.path().join("output")).unwrap();
        let ids = outputs
            .lines()
            .find_map(|line| line.strip_prefix("ids="))
            .unwrap();
        let downloads = self.root.path().join("runner-temp/ci-bundles");
        for id in ids.split(',') {
            let name = self
                .artifacts
                .values()
                .flatten()
                .find(|artifact| artifact["id"].as_u64() == id.parse().ok())
                .unwrap()["name"]
                .as_str()
                .unwrap();
            fs::create_dir_all(downloads.join(name)).unwrap();
            fs::copy(
                self.data().join("artifacts").join(id).join("bundle.tar"),
                downloads.join(name).join("bundle.tar"),
            )
            .unwrap();
        }
        fs::create_dir_all(self.signed()).unwrap();
        let packed = self.script(
            "pack-cli-bundles.sh",
            &[&downloads, &self.signed(), &self.archives()],
        );
        if !packed.status.success() {
            return packed;
        }
        self.script(
            "record-cli-signing.sh",
            &[&self.signed(), &self.archives(), &self.notes_path()],
        )
    }

    fn archives(&self) -> PathBuf {
        self.root.path().join("runner-temp/cli-bundles")
    }

    fn notes_path(&self) -> PathBuf {
        self.root.path().join("runner-temp/cli-signing.md")
    }

    /// The release notes' paragraph about signing.
    fn notes(&self) -> String {
        fs::read_to_string(self.notes_path()).unwrap()
    }

    /// The evidence record staging attaches to the release.
    fn evidence(&self) -> Value {
        serde_json::from_slice(&fs::read(self.archives().join("release-evidence.json")).unwrap())
            .unwrap()
    }
}

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn cli() -> String {
    format!("bin/{}", bundle::executable("nemoclaw"))
}

fn executable(name: &str) -> bool {
    ["bin/", "libexec/", "providers/"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// Write a complete bundle for this host, whose `nemoclaw` holds `contents`, to
/// `tar` as `dist/PLATFORM`, the way CI / Bundle packs it.
fn pack_bundle(platform: &str, contents: &str, tar: &Path) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("dist").join(platform);
    let mut files = BTreeMap::new();
    for name in bundle::required_files(PROVIDER_VERSION).unwrap() {
        let path = root.join(&name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, if name == cli() { contents } else { &name }).unwrap();
        let mode = if executable(&name) { 0o755 } else { 0o644 };
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        files.insert(name.clone(), bundle::hash_file(&path).unwrap());
    }
    let manifest = Manifest {
        version: PROVIDER_VERSION.into(),
        rust: "1.95.0".into(),
        opentofu: nemoclaw_sdk::compile::OPENTOFU_VERSION.into(),
        files,
    };
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let mut builder = tar::Builder::new(fs::File::create(tar).unwrap());
    builder
        .append_dir_all(format!("dist/{platform}"), &root)
        .unwrap();
    builder.finish().unwrap();
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

/// Extract a platform's archive of the release `tag` and return its bundle directory.
fn extract(archives: &Path, tag: &str, platform: &str, into: &Path) -> PathBuf {
    let archive =
        fs::File::open(archives.join(format!("nemoclaw-{tag}-{platform}.tar.gz"))).unwrap();
    tar::Archive::new(flate2::read::GzDecoder::new(archive))
        .unpack(into)
        .unwrap();
    into.join("dist").join(platform)
}

/// The bundled `nemoclaw`'s contents and mode in a platform's archive.
fn bundled_cli(archives: &Path, platform: &str) -> (String, u32) {
    let archive =
        fs::File::open(archives.join(format!("nemoclaw-{VERSION}-{platform}.tar.gz"))).unwrap();
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    for entry in tar.entries().unwrap() {
        let mut entry = entry.unwrap();
        if entry.path().unwrap() == Path::new(&format!("dist/{platform}/{}", cli())) {
            let mode = entry.header().mode().unwrap();
            let mut contents = String::new();
            entry.read_to_string(&mut contents).unwrap();
            return (contents, mode);
        }
    }
    panic!("the {platform} archive holds no dist/{platform}/{}", cli());
}

fn report(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn assert_checksums_verify(archives: &Path) {
    let sums = fs::read_to_string(archives.join("SHA256SUMS")).unwrap();
    assert_eq!(
        sums.lines().count(),
        4,
        "SHA256SUMS lists each archive: {sums}"
    );
    let check = Command::new("sha256sum")
        .args(["--check", "--strict", "SHA256SUMS"])
        .current_dir(archives)
        .output()
        .unwrap();
    assert!(
        check.status.success(),
        "the checksums verify: {}",
        report(&check)
    );
}

#[test]
fn each_platform_archive_holds_the_bundle_from_the_ci_run_for_the_tags_push() {
    let mut github = Github::new();
    github.run(11, "push", "v1", "success", &bundles("untagged", 1));
    github.run(
        12,
        "pull_request",
        "feature",
        "success",
        &bundles("pull request", 1),
    );
    github.run(13, "push", VERSION, "failure", &bundles("failed run", 1));
    let mut passing = bundles("first attempt", 1);
    passing.extend(bundles("rerun", 2));
    passing.push((
        format!("bundle-part-windows_amd64-{COMMIT}-2-cli"),
        "part".into(),
    ));
    github.run(14, "push", VERSION, "success", &passing);
    github.run(15, "push", "v1", "success", &bundles("untagged rerun", 1));
    // Only the tag's push run reports the tag; a manual run at it numbers its bundles.
    github.run(
        16,
        "workflow_dispatch",
        VERSION,
        "success",
        &bundles("manual run", 1),
    );

    let output = github.stage();
    assert!(output.status.success(), "{}", report(&output));

    let archives = github.archives();
    for platform in PLATFORMS {
        let (contents, mode) = bundled_cli(&archives, platform);
        assert_eq!(
            contents,
            format!("rerun {platform}"),
            "{platform}'s archive holds the push run's latest bundle"
        );
        assert_eq!(
            mode & 0o111,
            0o111,
            "{platform}'s nemoclaw stays executable"
        );
    }
    assert_checksums_verify(&archives);
}

#[test]
fn signed_executables_replace_the_checked_ones_and_the_staged_bundle_still_opens() {
    let mut github = Github::new();
    github.run(13, "push", VERSION, "success", &bundles("checked", 1));
    github.sign("windows_amd64", &cli(), "signed windows_amd64");
    github.sign("darwin_arm64", &cli(), "signed darwin_arm64");

    let output = github.stage();
    assert!(output.status.success(), "{}", report(&output));

    let archives = github.archives();
    for platform in PLATFORMS {
        let expected = match platform {
            "windows_amd64" | "darwin_arm64" => format!("signed {platform}"),
            _ => format!("checked {platform}"),
        };
        let (contents, mode) = bundled_cli(&archives, platform);
        assert_eq!(
            contents, expected,
            "{platform}'s archive holds its signed CLI"
        );
        assert_eq!(
            mode & 0o111,
            0o111,
            "{platform}'s nemoclaw stays executable"
        );
        let directory = tempfile::tempdir().unwrap();
        let extracted = extract(&archives, VERSION, platform, directory.path());
        if let Err(error) = Bundle::open(&extracted) {
            panic!("{platform}'s staged bundle opens: {error}");
        }
    }
    assert_checksums_verify(&archives);
}

#[test]
fn staging_fails_when_ci_has_not_run_at_the_tag() {
    let mut github = Github::new();
    github.run(11, "push", "v1", "success", &bundles("untagged", 1));
    github.run(
        12,
        "pull_request",
        "feature",
        "success",
        &bundles("pull request", 1),
    );

    let output = github.stage();
    let report = report(&output);
    assert!(!output.status.success(), "staging fails: {report}");
    assert!(
        report.contains("::error::") && report.contains(VERSION),
        "the error names the tag: {report}"
    );
    assert!(
        !github.archives().join("SHA256SUMS").exists(),
        "nothing is staged"
    );
}

#[test]
fn staging_fails_when_the_ci_run_for_the_tags_push_failed() {
    let mut github = Github::new();
    github.run(12, "push", VERSION, "failure", &bundles("failed run", 1));
    github.run(
        13,
        "workflow_dispatch",
        VERSION,
        "success",
        &bundles("manual run", 1),
    );

    let output = github.stage();
    let report = report(&output);
    assert!(!output.status.success(), "staging fails: {report}");
    assert!(
        report.contains("::error::https://github.com/NVIDIA/NemoClaw/actions/runs/12 failed"),
        "the error names the failed run: {report}"
    );
    assert!(
        !github.archives().join("SHA256SUMS").exists(),
        "nothing is staged"
    );
}

#[test]
fn staging_fails_naming_each_platform_whose_checked_bundle_expired() {
    let mut github = Github::new();
    github.run(13, "push", VERSION, "success", &bundles("checked", 1));
    github.expire(13, &format!("bundle-linux_amd64-{COMMIT}-1"));

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
    assert!(
        error.contains("gh run rerun 13") && !error.contains("gh workflow run"),
        "a new attempt of the tag's push run reports the tag, and a manual run doesn't: {error}"
    );
}

/// Staging for the final tag FINAL, whose CI / Bundle run passed.
fn final_release() -> Github {
    let mut github = Github::new();
    github.tag = FINAL.into();
    github.run(13, "push", FINAL, "success", &bundles("checked", 1));
    github
}

fn errors(report: &str) -> Vec<&str> {
    report
        .lines()
        .filter(|line| line.starts_with("::error::"))
        .collect()
}

fn sha256(path: &Path) -> String {
    let output = Command::new("sha256sum").arg(path).output().unwrap();
    assert!(output.status.success(), "{}", report(&output));
    String::from_utf8(output.stdout).unwrap()[..64].to_owned()
}

#[test]
fn a_final_release_fails_unless_its_macos_and_windows_executables_are_signed() {
    let github = final_release();
    github.sign("windows_amd64", &cli(), "signed windows_amd64");

    let output = github.stage();
    let report = report(&output);
    assert!(!output.status.success(), "staging fails: {report}");
    let errors = errors(&report);
    assert!(
        errors.iter().any(|line| line.contains("darwin_arm64")),
        "the error names the unsigned platform: {report}"
    );
    assert!(
        !errors.iter().any(|line| line.contains("windows_amd64")),
        "only the unsigned platform: {report}"
    );
    assert!(
        !github.archives().join("release-evidence.json").exists(),
        "no evidence is recorded"
    );
}

#[test]
fn a_final_release_with_its_own_exception_stages_unsigned_and_the_notes_give_the_reason() {
    let mut github = final_release();
    github.exception = Some(format!("{FINAL}:Apple Developer ID pending: see #14621"));

    let output = github.stage();
    assert!(output.status.success(), "{}", report(&output));

    let notes = github.notes();
    for expected in [
        "darwin_arm64",
        "windows_amd64",
        "Apple Developer ID pending: see #14621",
    ] {
        assert!(
            notes.contains(expected),
            "the notes name {expected}: {notes}"
        );
    }
    assert_eq!(
        github.evidence()["signing"],
        json!({
            "required": true,
            "unsigned": ["darwin_arm64", "windows_amd64"],
            "exception": "Apple Developer ID pending: see #14621",
        })
    );
}

#[test]
fn an_exception_for_another_release_or_without_a_reason_does_not_apply() {
    for exception in [
        format!("{VERSION}:candidate only"),
        "v0.1.1:next release".to_owned(),
        format!("{FINAL}:"),
        FINAL.to_owned(),
    ] {
        let mut github = final_release();
        github.exception = Some(exception.clone());

        let output = github.stage();
        let report = report(&output);
        assert!(
            !output.status.success(),
            "{exception} doesn't let staging pass: {report}"
        );
        assert!(
            errors(&report)
                .iter()
                .any(|line| line.contains("RELEASE_UNSIGNED_EXCEPTION")),
            "the error says how to make an exception: {report}"
        );
    }
}

#[test]
fn a_release_candidate_may_stay_unsigned() {
    let mut github = Github::new();
    github.run(13, "push", VERSION, "success", &bundles("checked", 1));
    github.exception = Some("v0.1.1:another release".into());

    let output = github.stage();
    assert!(output.status.success(), "{}", report(&output));

    assert_eq!(
        github.evidence()["signing"],
        json!({
            "required": false,
            "unsigned": ["darwin_arm64", "windows_amd64"],
            "exception": null,
        })
    );
    let notes = github.notes();
    assert!(
        notes.contains("darwin_arm64") && notes.contains("windows_amd64"),
        "the notes name the unsigned platforms: {notes}"
    );
}

#[test]
fn the_evidence_records_each_archive_its_signed_executables_and_their_checks() {
    let github = final_release();
    // Each signing job uploads the whole bundle: OpenTofu is signed on macOS
    // and left as upstream ships it on Windows.
    github.sign("windows_amd64", &cli(), "signed windows_amd64");
    github.upload("windows_amd64", "libexec/tofu", "upstream tofu");
    github.sign("darwin_arm64", &cli(), "signed darwin_arm64");
    github.sign("darwin_arm64", "libexec/tofu", "signed tofu");

    let output = github.stage();
    assert!(output.status.success(), "{}", report(&output));

    let evidence = github.evidence();
    assert_eq!(evidence["version"], FINAL);
    assert_eq!(evidence["commit"], COMMIT);
    assert_eq!(
        evidence["run"],
        "https://github.com/NVIDIA/NemoClaw/actions/runs/4242/attempts/2"
    );
    assert_eq!(
        evidence["signing"],
        json!({ "required": true, "unsigned": [], "exception": null })
    );
    let archives = github.archives();
    let recorded = evidence["archives"].as_array().unwrap();
    assert_eq!(recorded.len(), PLATFORMS.len(), "{evidence:#}");
    for (entry, platform) in recorded.iter().zip(PLATFORMS) {
        let archive = format!("nemoclaw-{FINAL}-{platform}.tar.gz");
        assert_eq!(entry["platform"], platform);
        assert_eq!(entry["archive"], archive.as_str());
        assert_eq!(entry["sha256"], sha256(&archives.join(&archive)).as_str());
        match platform {
            "darwin_arm64" | "windows_amd64" => {
                let directory = tempfile::tempdir().unwrap();
                let bundle = extract(&archives, FINAL, platform, directory.path());
                let mut signed = vec![cli()];
                let mut checks = format!("Successfully verified: {}\n", cli());
                if platform == "darwin_arm64" {
                    signed.push("libexec/tofu".into());
                    checks.push_str("Successfully verified: libexec/tofu\n");
                }
                let signed: Vec<_> = signed
                    .iter()
                    .map(|path| json!({ "path": path, "sha256": sha256(&bundle.join(path)) }))
                    .collect();
                assert_eq!(
                    entry["signed"],
                    json!(signed),
                    "{platform}'s signed programs are the archived ones"
                );
                assert_eq!(
                    entry["signature_verification"],
                    checks.as_str(),
                    "{platform}'s signing job's check"
                );
            }
            _ => {
                assert_eq!(entry["signed"], json!([]), "{platform} isn't code signed");
                assert_eq!(entry["signature_verification"], Value::Null);
            }
        }
    }
    let verification = &evidence["verification"][0];
    assert_eq!(
        verification["command"],
        "sha256sum --check --strict SHA256SUMS"
    );
    for platform in PLATFORMS {
        let line = format!("nemoclaw-{FINAL}-{platform}.tar.gz: OK");
        assert!(
            verification["output"].as_str().unwrap().contains(&line),
            "the checksum check passes for {platform}: {evidence:#}"
        );
    }
    let notes = github.notes();
    assert!(
        notes.contains("release-evidence.json"),
        "the notes point to the evidence: {notes}"
    );
}

/// A bundle directory holding each program at its Windows path.
fn windows_programs(extra: &[&str]) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    for name in WINDOWS_PROGRAMS
        .iter()
        .map(|(_, name)| *name)
        .chain(extra.iter().copied())
    {
        let path = directory.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, name).unwrap();
    }
    let license = directory.path().join("licenses/helm-provider-LICENSE");
    fs::create_dir_all(license.parent().unwrap()).unwrap();
    fs::write(license, "license").unwrap();
    directory
}

/// Each program at its Windows path, with whose signature it carries there.
const WINDOWS_PROGRAMS: [(&str, &str); 9] = [
    ("nvidia", "bin/nemoclaw.exe"),
    ("none", "libexec/tofu.exe"),
    (
        "hashicorp",
        "providers/registry.opentofu.org/hashicorp/helm/3.3.0/windows_amd64/terraform-provider-helm_v3.3.0_x5.exe",
    ),
    (
        "none",
        "providers/registry.opentofu.org/kreuzwerker/docker/4.7.0/windows_amd64/terraform-provider-docker_v4.7.0.exe",
    ),
    (
        "nvidia",
        "providers/registry.opentofu.org/nvidia/fabric/0.1.0/windows_amd64/terraform-provider-fabric_v0.1.0.exe",
    ),
    (
        "nvidia",
        "providers/registry.opentofu.org/nvidia/host/0.1.0/windows_amd64/terraform-provider-host_v0.1.0.exe",
    ),
    (
        "nvidia",
        "providers/registry.opentofu.org/nvidia/ollama/0.1.0/windows_amd64/terraform-provider-ollama_v0.1.0.exe",
    ),
    (
        "nvidia",
        "providers/registry.opentofu.org/nvidia/openshell/0.1.0/windows_amd64/terraform-provider-openshell_v0.1.0.exe",
    ),
    (
        "nvidia",
        "providers/registry.opentofu.org/nvidia/vllm/0.1.0/windows_amd64/terraform-provider-vllm_v0.1.0.exe",
    ),
];

fn inventory(bundle: &Path, platform: &str) -> Output {
    Command::new("/bin/bash")
        .args(["--noprofile", "--norc", "-e"])
        .arg(repository().join(".github/scripts/signing-inventory.sh"))
        .arg(bundle)
        .arg(platform)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap()
}

#[test]
fn nvidia_signs_its_own_programs_everywhere_and_opentofu_and_the_docker_provider_only_on_macos() {
    let bundle = windows_programs(&[]);
    let output = inventory(bundle.path(), "windows_amd64");
    assert!(output.status.success(), "{}", report(&output));
    let expected: String = WINDOWS_PROGRAMS
        .iter()
        .map(|(signer, name)| format!("{signer}\t{name}\n"))
        .collect();
    assert_eq!(String::from_utf8_lossy(&output.stdout), expected);

    // The same programs on macOS: NVIDIA signs OpenTofu and the Docker
    // provider too, and the Helm provider keeps HashiCorp's signature.
    let output = inventory(bundle.path(), "darwin_arm64");
    assert!(output.status.success(), "{}", report(&output));
    let expected: String = WINDOWS_PROGRAMS
        .iter()
        .map(|(signer, name)| {
            let signer = if *signer == "none" { "nvidia" } else { signer };
            format!("{signer}\t{name}\n")
        })
        .collect();
    assert_eq!(String::from_utf8_lossy(&output.stdout), expected);
}

#[test]
fn a_program_the_signing_inventory_does_not_classify_stops_signing() {
    let bundle = windows_programs(&["libexec/kubectl.exe"]);
    for platform in ["windows_amd64", "darwin_arm64"] {
        let output = inventory(bundle.path(), platform);
        let report = report(&output);
        assert!(!output.status.success(), "{platform}: {report}");
        assert!(
            report.contains("libexec/kubectl.exe isn't in the signing inventory"),
            "{platform}: the error names the program: {report}"
        );
    }
}

const NVIDIA_TEAM: &str = "NVTEAM1234";

/// A darwin bundle's executables, signed as `signatures` says, and its license.
fn darwin_bundle(signatures: &[(&str, &str)]) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let license = directory.path().join("licenses/helm-provider-LICENSE");
    fs::create_dir_all(license.parent().unwrap()).unwrap();
    fs::write(&license, "license").unwrap();
    for (name, signature) in signatures {
        let path = directory.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, signature).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    directory
}

fn verify_macos(bundle: &Path) -> Output {
    let bin = tempfile::tempdir().unwrap();
    fs::write(bin.path().join("codesign"), FAKE_CODESIGN).unwrap();
    fs::set_permissions(
        bin.path().join("codesign"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    Command::new("/bin/bash")
        .args(["--noprofile", "--norc", "-e"])
        .arg(repository().join(".github/scripts/verify-macos-signatures.sh"))
        .arg(bundle)
        .arg(NVIDIA_TEAM)
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", bin.path().display()))
        .output()
        .unwrap()
}

#[test]
fn macos_verification_requires_notarized_nvidia_signatures_and_hashicorps_on_the_helm_provider() {
    let helm = bundle::helm_provider_path("darwin_arm64").unwrap();
    let openshell = format!(
        "providers/registry.opentofu.org/nvidia/openshell/{PROVIDER_VERSION}/darwin_arm64/terraform-provider-openshell_v{PROVIDER_VERSION}"
    );
    let nvidia = format!("notarized {NVIDIA_TEAM}");
    let signed = darwin_bundle(&[
        ("bin/nemoclaw", &nvidia),
        ("libexec/tofu", &nvidia),
        (&openshell, &nvidia),
        (&helm, "notarized D38WU7D763"),
    ]);
    let output = verify_macos(signed.path());
    assert!(
        output.status.success(),
        "a notarized bundle verifies: {}",
        report(&output)
    );

    // OpenTofu's own ad hoc signature, and the Helm provider re-signed with
    // NVIDIA's identity in place of HashiCorp's.
    let unsigned = darwin_bundle(&[
        ("bin/nemoclaw", &nvidia),
        ("libexec/tofu", "adhoc"),
        (&openshell, &nvidia),
        (&helm, &nvidia),
    ]);
    let output = verify_macos(unsigned.path());
    let report = report(&output);
    assert!(!output.status.success(), "verification fails: {report}");
    let errors: Vec<_> = report
        .lines()
        .filter(|line| line.starts_with("::error"))
        .collect();
    assert!(
        errors.iter().any(|line| line.contains("libexec/tofu")),
        "the error names the ad hoc signed tofu: {report}"
    );
    assert!(
        errors.iter().any(|line| line.contains(&helm)),
        "the error names the re-signed Helm provider: {report}"
    );
    assert_eq!(errors.len(), 2, "only those two fail: {report}");
}
