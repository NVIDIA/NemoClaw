// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! macOS verification scripts against a local signing-tool fixture.
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};
fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn report(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}
/// Verifies fixture signatures and optional notarization against an Apple team.
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
[ -n "$verify" ] && [ -n "$strict" ] || { echo "unexpected codesign $*" >&2; exit 2; }
case "$requirement" in
  'notarized and '*)
    [ -n "$notarization" ] || exit 2
    requirement=${requirement#'notarized and '}
    expected=notarized ;;
  *)
    [ -z "$notarization" ] || exit 2
    expected=signed ;;
esac
ident=
case "$requirement" in
  'identifier "'*)
    ident=${requirement#'identifier "'}
    ident=${ident%%'"'*}
    requirement=${requirement#*'" and '} ;;
esac
team=$(printf '%s\n' "$requirement" | sed -n 's/^anchor apple generic and certificate leaf\[subject.OU\] = "\(.*\)"$/\1/p')
[ -n "$team" ] || { echo "unexpected requirement $requirement" >&2; exit 2; }
signer="$team${ident:+ $ident}"
actual=$(cat "$file")
if [ "$expected" = signed ] && [ "$actual" = "notarized $signer" ]; then exit 0; fi
[ "$actual" = "$expected $signer" ] || { echo "$file: test-requirement: code failed to satisfy specified code requirement(s)" >&2; exit 3; }
"#;

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
    verify_macos_mode(bundle, "notarized")
}

fn verify_macos_mode(bundle: &Path, mode: &str) -> Output {
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
        .arg(mode)
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", bin.path().display()))
        .output()
        .unwrap()
}

#[test]
fn macos_verification_requires_notarized_nvidia_signatures_and_hashicorps_on_the_helm_provider() {
    let helm =
        "providers/registry.opentofu.org/hashicorp/helm/3.1.1/darwin_arm64/terraform-provider-helm"
            .to_owned();
    let openshell = String::from(
        "providers/nvidia.github.io/nemoclaw/openshell/0.1.0/darwin_arm64/terraform-provider-openshell_v0.1.0",
    );
    let nvidia =
        |identifier: &str| format!("notarized {NVIDIA_TEAM} com.nvidia.nemoclaw.{identifier}");
    let signed = darwin_bundle(&[
        ("bin/nemoclaw", &nvidia("nemoclaw")),
        ("libexec/tofu", &nvidia("tofu")),
        (&openshell, &nvidia("terraform-provider-openshell")),
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
        ("bin/nemoclaw", &nvidia("nemoclaw")),
        ("libexec/tofu", "adhoc"),
        (&openshell, &nvidia("terraform-provider-openshell")),
        (&helm, &nvidia("terraform-provider-helm")),
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

#[test]
fn macos_can_verify_signatures_without_claiming_notarization() {
    let signature = format!("signed {NVIDIA_TEAM} com.nvidia.nemoclaw.nemoclaw");
    let helm =
        "providers/registry.opentofu.org/hashicorp/helm/3.1.1/darwin_arm64/terraform-provider-helm";
    let bundle = darwin_bundle(&[("bin/nemoclaw", &signature), (helm, "notarized D38WU7D763")]);
    let output = verify_macos_mode(bundle.path(), "signatures-only");
    assert!(output.status.success(), "{}", report(&output));
    assert!(report(&output).contains("Notarization: skipped"));
    assert!(!verify_macos(bundle.path()).status.success());
}

#[test]
fn macos_signature_only_checks_still_reject_adhoc_and_wrong_signers() {
    let helm =
        "providers/registry.opentofu.org/hashicorp/helm/3.1.1/darwin_arm64/terraform-provider-helm"
            .to_owned();
    for (name, signature) in [
        ("bin/nemoclaw", "adhoc"),
        (
            "bin/nemoclaw",
            "signed WRONGTEAM com.nvidia.nemoclaw.nemoclaw",
        ),
        // One identifier for every program, as when 3S signed a file named payload.
        ("bin/nemoclaw", "signed NVTEAM1234 payload"),
        (helm.as_str(), "signed 6KR3T733EC"),
    ] {
        let bundle = darwin_bundle(&[(name, signature)]);
        let output = verify_macos_mode(bundle.path(), "signatures-only");
        assert!(!output.status.success(), "{name}: {}", report(&output));
    }
}

#[test]
fn macos_verification_rejects_unknown_modes() {
    let signature = format!("notarized {NVIDIA_TEAM}");
    let bundle = darwin_bundle(&[("bin/nemoclaw", &signature)]);
    let output = verify_macos_mode(bundle.path(), "typo");
    assert!(!output.status.success());
    assert!(report(&output).contains("Unknown macOS verification mode"));
}
