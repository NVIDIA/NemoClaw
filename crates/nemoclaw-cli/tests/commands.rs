// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{fs, process::Command};

#[test]
fn invalid_configuration_fails_before_creating_state_or_echoing_secrets() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let config = directory.path().join("input.yaml");
    fs::write(&config, "apiKey: secret-sentinel").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .arg("apply")
        .arg(config)
        .arg("--state-dir")
        .arg(&state)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!state.exists());
    assert!(output.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("secret-sentinel"));
}
#[test]
fn bundle_flag_selects_an_explicit_bundle() {
    let directory = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args(["export", "--bundle"])
        .arg(directory.path())
        .arg("--state-dir")
        .arg(directory.path().join("state"))
        .output()
        .unwrap();
    // Missing bundle contents is an operation failure (1), not a rejected flag (2).
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
}

#[test]
fn failed_export_preserves_existing_output_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("export.yaml");
    fs::write(&path, "existing configuration").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args(["export", "--output"])
        .arg(&path)
        .arg("--bundle")
        .arg(directory.path())
        .arg("--state-dir")
        .arg(directory.path().join("state"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(fs::read_to_string(path).unwrap(), "existing configuration");
}

#[test]
fn piped_input_requires_dash_and_usage_errors_exit_two() {
    use std::{io::Write, process::Stdio};
    for (args, expected) in [(vec!["apply", "-"], 1), (vec!["apply"], 2)] {
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("state");
        let mut child = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
            .args(args)
            .arg("--state-dir")
            .arg(&state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let _ = child
            .stdin
            .take()
            .unwrap()
            .write_all(b"apiKey: secret-sentinel");
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(expected));
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("secret-sentinel"));
        assert!(!state.exists());
    }
}

#[test]
fn verbose_reports_failed_steps_on_stderr_without_changing_stdout() {
    let directory = tempfile::tempdir().unwrap();
    for verbose in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw"));
        command.args(["export", "--bundle"]).arg(directory.path());
        command
            .arg("--state-dir")
            .arg(directory.path().join("state"));
        if verbose {
            command.arg("--verbose");
        }
        let output = command.output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert_eq!(stderr.contains("bundle.verify failed"), verbose, "{stderr}");
        assert!(!stderr.contains(directory.path().to_str().unwrap()));
    }
}

fn write_credential_document(directory: &std::path::Path) -> std::path::PathBuf {
    let path = directory.join("credential-input.yaml");
    let yaml = include_str!("../../../examples/openclaw-dashboard.yaml").replace(
        "      endpoint: https://inference.example.com/v1",
        "      endpoint: https://inference.example.com/v1\n      credential: {env: STORY_CREDENTIAL_KEY}",
    );
    fs::write(&path, yaml).unwrap();
    path
}

#[test]
fn lifecycle_credential_fulfillment_is_transient_redacted_and_precedes_execution() {
    use std::{io::Write, process::Stdio};

    let directory = tempfile::tempdir().unwrap();
    let document = write_credential_document(directory.path());
    let state = directory.path().join("state-must-not-exist");
    let bundle = directory.path().join("missing-bundle");
    let missing = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args(["apply", "--non-interactive"])
        .arg(&document)
        .arg("--bundle")
        .arg(&bundle)
        .arg("--state-dir")
        .arg(&state)
        .env_remove("STORY_CREDENTIAL_KEY")
        .output()
        .unwrap();
    assert!(!missing.status.success());
    assert!(missing.stdout.is_empty());
    assert_eq!(
        String::from_utf8(missing.stderr).unwrap(),
        "missing credential environment variables: STORY_CREDENTIAL_KEY\n"
    );
    assert!(!state.exists());

    let sentinel = "lifecycle-credential-value-sentinel";
    let from_environment = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .arg("plan")
        .arg(&document)
        .arg("--non-interactive")
        .arg("--bundle")
        .arg(&bundle)
        .arg("--state-dir")
        .arg(&state)
        .env("STORY_CREDENTIAL_KEY", sentinel)
        .output()
        .unwrap();
    assert!(!from_environment.status.success());
    assert!(!String::from_utf8_lossy(&from_environment.stderr).contains(sentinel));
    assert!(!state.exists());

    let mut prompted = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .arg("apply")
        .arg(&document)
        .arg("--bundle")
        .arg(&bundle)
        .arg("--state-dir")
        .arg(&state)
        .env_remove("STORY_CREDENTIAL_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    prompted
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{sentinel}\n").as_bytes())
        .unwrap();
    let prompted = prompted.wait_with_output().unwrap();
    assert!(!prompted.status.success());
    let stderr = String::from_utf8(prompted.stderr).unwrap();
    assert!(stderr.starts_with("Credential for STORY_CREDENTIAL_KEY: "));
    assert!(!stderr.contains(sentinel));
    assert!(!state.exists());
}

#[test]
fn stdin_configuration_requires_environment_credentials_without_prompting() {
    use std::{io::Write, process::Stdio};

    let directory = tempfile::tempdir().unwrap();
    let document = write_credential_document(directory.path());
    let mut child = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args(["apply", "-"])
        .arg("--bundle")
        .arg(directory.path().join("missing-bundle"))
        .arg("--state-dir")
        .arg(directory.path().join("state-must-not-exist"))
        .env_remove("STORY_CREDENTIAL_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&fs::read(document).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("reading configuration from stdin"),
        "{stderr}"
    );
    assert!(stderr.contains("STORY_CREDENTIAL_KEY"), "{stderr}");
    assert!(!stderr.contains("Credential for"), "{stderr}");
}

#[test]
fn desired_state_reaches_plan_and_apply_unchanged() {
    qualify_lifecycle_boundary();
}

fn qualify_lifecycle_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let document = write_credential_document(directory.path());
    let generated = fs::read(&document).unwrap();
    let bundle = directory.path().join("missing-bundle");
    let sentinel = "generated-lifecycle-qualification-sentinel";

    for operation in ["plan", "apply"] {
        let state = directory.path().join(format!("{operation}-state"));
        let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
            .arg(operation)
            .arg(&document)
            .arg("--non-interactive")
            .arg("--bundle")
            .arg(&bundle)
            .arg("--state-dir")
            .arg(&state)
            .env("STORY_CREDENTIAL_KEY", sentinel)
            .output()
            .unwrap();

        assert_eq!(output.status.code(), Some(1), "{operation}");
        assert!(output.stdout.is_empty(), "{operation}");
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert_eq!(stderr, "bundle directory is unavailable\n", "{operation}");
        assert!(!stderr.contains(sentinel), "{operation}");
        assert!(!state.exists(), "{operation}");
        assert_eq!(fs::read(&document).unwrap(), generated, "{operation}");
    }
}

#[test]
fn removed_bundle_dir_flag_is_a_usage_error() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args(["export", "--bundle-dir"])
        .arg(root.path())
        .arg("--state-dir")
        .arg(&state)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(!state.exists());
}
