// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! CI lifecycle selection at the command boundary, without compiling or deploying fixtures.

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    process::{Command, Output},
};

struct Fixture(tempfile::TempDir);

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();
        for (name, script) in [
            ("protoc", "#!/bin/sh\nprintf 'libprotoc 36.1\\n'\n"),
            (
                "cargo",
                r#"#!/bin/sh
if [ "$1 $2" = 'nextest --version' ]; then
    printf 'cargo-nextest 0.9.144\n'
    exit 0
fi
printf '%s\n' "$@" > arguments
if [ "$1 $2" = 'nextest list' ]; then
    printf '%s\n' "$CARGO_LIST"
    exit "${CARGO_RESULT:-0}"
fi
printf '%s\n' "$NEMOCLAW_TEST_BUNDLE" "$NEMOCLAW_TEST_TOFU" "$NEMOCLAW_TEST_PROVIDER" > inputs
exit "${CARGO_RESULT:-0}"
"#,
            ),
        ] {
            let path = bin.join(name);
            fs::write(&path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(
            root.path().join("versions.json"),
            include_bytes!("../../../versions.json"),
        )
        .unwrap();
        Self(root)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"));
        command
            .arg("ci")
            .args(args)
            .current_dir(self.0.path())
            .env("CARGO", self.0.path().join("bin/cargo"))
            .env("CARGO_LIST", r#"{"rust-suites":{"selected-suite":{"testcases":{"selected":{"filter-match":{"status":"matches"}}}},"unselected-suite":{"testcases":{"unselected":{"filter-match":{"status":"mismatch"}}}}}}"#)
            .env("PROTOC", self.0.path().join("bin/protoc"))
            .env("PATH", self.0.path().join("bin"))
            .env("TEST_PLATFORM", "linux_arm64")
            .env_remove("GITHUB_ENV")
            .env_remove("GITHUB_PATH");
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn arguments(&self) -> String {
        fs::read_to_string(self.0.path().join("arguments")).unwrap()
    }
}

#[test]
fn lifecycle_partition_reaches_nextest_without_changing_the_selected_suite() {
    let fixture = Fixture::new();
    let output = fixture.run(&["lifecycle", "--partition", "hash:1/2"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = fixture.arguments();
    assert!(args.contains("--partition\nhash:1/2\n"), "{args}");
    assert!(
        args.contains("--profile\nlifecycle\n--run-ignored\nonly\n"),
        "{args}"
    );
    let inputs = fs::read_to_string(fixture.0.path().join("inputs")).unwrap();
    assert!(inputs.contains("dist/linux_arm64/libexec/tofu"), "{inputs}");
    assert!(
        inputs.contains("target/debug/terraform-provider-nemoclaw"),
        "{inputs}"
    );
}

#[test]
fn archived_lifecycle_uses_the_checkout_without_building_again() {
    let fixture = Fixture::new();
    let output = fixture.run(&[
        "lifecycle",
        "--partition",
        "hash:2/2",
        "--archive-file",
        "tests.tar.zst",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = fixture.arguments();
    assert!(args.contains("--archive-file\ntests.tar.zst\n"), "{args}");
    assert!(fixture.0.path().join(".build/ci/extracted").is_dir());
    let workspace_remap = args
        .lines()
        .skip_while(|arg| *arg != "--workspace-remap")
        .nth(1)
        .expect("--workspace-remap needs a checkout path");
    // macOS temporary paths can use /var while current_dir resolves /private/var.
    assert_eq!(
        fs::canonicalize(workspace_remap).unwrap(),
        fixture.0.path().canonicalize().unwrap(),
        "{args}"
    );
    assert!(
        args.contains("--profile\nlifecycle\n--run-ignored\nonly\n"),
        "{args}"
    );
    assert!(args.contains("--partition\nhash:2/2\n"), "{args}");
    for build_option in ["--workspace\n", "--all-targets\n", "--locked\n"] {
        assert!(
            !args.contains(build_option),
            "archive execution must not request a build: {args}"
        );
    }
}

#[test]
fn lifecycle_options_cannot_silently_narrow_default_or_other_ci_steps() {
    for args in [
        vec!["--partition", "hash:1/2"],
        vec!["test", "--partition", "hash:1/2"],
        vec!["fmt", "--archive-file", "tests.tar.zst"],
        vec!["--archive-file", "tests.tar.zst"],
    ] {
        let fixture = Fixture::new();
        let output = fixture.run(&args);
        assert!(!output.status.success());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(
            error.contains("--partition and --archive-file require ci lifecycle"),
            "{error}"
        );
        assert!(!fixture.0.path().join("arguments").exists());
        assert!(!fixture.0.path().join(".build").exists());
    }
}

#[test]
fn archive_packages_the_bundle_tools_and_provider_helpers_with_executable_modes() {
    let fixture = Fixture::new();
    for path in [
        "dist/linux_arm64/bin/nemoclaw",
        "dist/linux_arm64/libexec/tofu",
        ".tools/protoc-36.1/bin/protoc",
        ".tools/nextest-0.9.144/cargo-nextest",
        "target/debug/terraform-provider-nemoclaw",
        "target/debug/terraform-provider-openshell",
        "target/debug/terraform-provider-fabric",
    ] {
        let file = fixture.0.path().join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, path).unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o755)).unwrap();
    }
    // Tool discovery uses the fixture's explicit PROTOC and cargo commands.
    let output = fixture.run(&["archive"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = fixture.arguments();
    assert!(
        args.starts_with("nextest\narchive\n--locked\n--workspace\n--all-targets\n"),
        "{args}"
    );
    assert!(
        args.contains("--filterset\nbinary_id(=selected-suite)\n"),
        "{args}"
    );
    let packed = fs::File::open(fixture.0.path().join(".build/ci/lifecycle-inputs.tar")).unwrap();
    let unpacked = tempfile::tempdir().unwrap();
    tar::Archive::new(packed).unpack(unpacked.path()).unwrap();
    for path in [
        "dist/linux_arm64/bin/nemoclaw",
        ".tools/nextest-0.9.144/cargo-nextest",
        "target/debug/terraform-provider-nemoclaw",
        "target/debug/terraform-provider-openshell",
        "target/debug/terraform-provider-fabric",
    ] {
        let file = unpacked.path().join(path);
        assert_eq!(fs::read_to_string(&file).unwrap(), path);
        assert_ne!(fs::metadata(file).unwrap().permissions().mode() & 0o111, 0);
    }
    assert_eq!(
        fs::read(unpacked.path().join(".build/ci/nemoclaw-build")).unwrap(),
        fs::read(env!("CARGO_BIN_EXE_nemoclaw-build")).unwrap()
    );
}

#[test]
fn archive_rejects_an_empty_lifecycle_selection_instead_of_publishing_no_tests() {
    let fixture = Fixture::new();
    let output = fixture
        .command(&["archive"])
        .env("CARGO_LIST", r#"{"rust-suites":{}}"#)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("no lifecycle test binaries were selected"),
        "{error}"
    );
    assert!(
        !fixture
            .0
            .path()
            .join(".build/ci/lifecycle-inputs.tar")
            .exists()
    );
}

#[test]
fn a_failed_lifecycle_partition_fails_ci() {
    let fixture = Fixture::new();
    let output = fixture
        .command(&["lifecycle", "--partition", "hash:1/2"])
        .env("CARGO_RESULT", "42")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("CI step lifecycle failed"));
}
