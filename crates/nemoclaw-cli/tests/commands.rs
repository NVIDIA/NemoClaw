// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
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

fn generate_credential_document(directory: &std::path::Path) -> std::path::PathBuf {
    let path = directory.join("credential-input.yaml");
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args([
            "onboard",
            "--generate-only",
            "--non-interactive",
            "--output",
        ])
        .arg(&path)
        .args(["--credential-env", "STORY_CREDENTIAL_KEY"])
        .output()
        .unwrap();
    assert!(output.status.success());
    path
}

#[test]
fn lifecycle_credential_fulfillment_is_transient_redacted_and_precedes_execution() {
    use std::{io::Write, process::Stdio};

    let directory = tempfile::tempdir().unwrap();
    let document = generate_credential_document(directory.path());
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
    let document = generate_credential_document(directory.path());
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
fn generated_yaml_reaches_standalone_plan_and_apply_unchanged() {
    qualify_generated_lifecycle_boundary();
}

fn qualify_generated_lifecycle_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let document = generate_credential_document(directory.path());
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
fn non_interactive_onboarding_publishes_without_lifecycle_dependencies() {
    let directory = tempfile::tempdir().unwrap();
    let output_path = directory.path().join("deployment.yaml");
    fs::write(&output_path, "complete prior file").unwrap();
    let state_path = directory.path().join("state-must-not-exist");
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args([
            "onboard",
            "--generate-only",
            "--non-interactive",
            "--output",
        ])
        .arg(&output_path)
        .args(["--name", "direct-deployment", "--bundle"])
        .arg(directory.path().join("missing-bundle"))
        .arg("--state-dir")
        .arg(&state_path)
        .env("NVIDIA_INFERENCE_API_KEY", "nvapi-secret-sentinel")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert!(!state_path.exists());
    let bytes = fs::read(&output_path).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("secret-sentinel"));
    let document = Document::parse(bytes.as_slice()).unwrap();
    assert_eq!(document.metadata.name, "direct-deployment");
    assert_eq!(document.credential_names(), ["NVIDIA_INFERENCE_API_KEY"]);
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("Credential references: NVIDIA_INFERENCE_API_KEY")
    );
    assert!(!String::from_utf8_lossy(&output.stderr).contains("secret-sentinel"));
}

#[test]
fn generation_only_stops_before_credential_fulfillment() {
    let directory = tempfile::tempdir().unwrap();
    let output_path = directory.path().join("deployment.yaml");
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args([
            "onboard",
            "--generate-only",
            "--non-interactive",
            "--output",
        ])
        .arg(&output_path)
        .args(["--credential-env", "GENERATION_ONLY_MISSING_KEY"])
        .env_remove("GENERATION_ONLY_MISSING_KEY")
        .output()
        .unwrap();

    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output_path.exists());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("missing credential"));
}

#[test]
fn composed_onboarding_publishes_before_credential_or_plan_failure() {
    let directory = tempfile::tempdir().unwrap();
    let output_path = directory.path().join("deployment.yaml");
    let state_path = directory.path().join("state-must-not-exist");
    let bundle_path = directory.path().join("missing-bundle");

    let missing_credential = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args(["onboard", "--non-interactive", "--output"])
        .arg(&output_path)
        .args(["--credential-env", "COMPOSED_MISSING_KEY", "--bundle"])
        .arg(&bundle_path)
        .arg("--state-dir")
        .arg(&state_path)
        .env_remove("COMPOSED_MISSING_KEY")
        .output()
        .unwrap();
    assert_eq!(missing_credential.status.code(), Some(1));
    assert!(output_path.exists());
    assert!(
        String::from_utf8_lossy(&missing_credential.stderr)
            .contains("missing credential environment variables: COMPOSED_MISSING_KEY")
    );
    assert!(!state_path.exists());

    let failed_plan = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args(["onboard", "--non-interactive", "--output"])
        .arg(&output_path)
        .args(["--credential-env", "COMPOSED_MISSING_KEY", "--bundle"])
        .arg(&bundle_path)
        .arg("--state-dir")
        .arg(&state_path)
        .env("COMPOSED_MISSING_KEY", "secret-sentinel")
        .output()
        .unwrap();
    assert_eq!(failed_plan.status.code(), Some(1));
    Document::parse(fs::read(&output_path).unwrap().as_slice()).unwrap();
    let stderr = String::from_utf8(failed_plan.stderr).unwrap();
    assert_eq!(
        stderr,
        "Credential references: COMPOSED_MISSING_KEY\nbundle directory is unavailable\n"
    );
    assert!(!stderr.contains("secret-sentinel"));
    assert!(!state_path.exists());
}

#[test]
fn interactive_onboarding_uses_the_same_published_contract() {
    use std::{io::Write, process::Stdio};

    let directory = tempfile::tempdir().unwrap();
    let output_path = directory.path().join("deployment.yaml");
    let state_path = directory.path().join("state-must-not-exist");
    let mut child = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args(["onboard", "--generate-only", "--output"])
        .arg(&output_path)
        .arg("--bundle")
        .arg(directory.path().join("missing-bundle"))
        .arg("--state-dir")
        .arg(&state_path)
        .env("NVIDIA_INFERENCE_API_KEY", "nvapi-interactive-secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"interactive-deployment\n\n\n\n\n\ny\na\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert!(!state_path.exists());
    let document = Document::parse(fs::read(&output_path).unwrap().as_slice()).unwrap();
    assert_eq!(document.metadata.name, "interactive-deployment");
    assert_eq!(document.credential_names(), ["NVIDIA_INFERENCE_API_KEY"]);
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("Review authored configuration"));
    assert!(stderr.contains("apiVersion: nemoclaw.nvidia.com/v1alpha1"));
    assert!(!stderr.contains("interactive-secret"));
}

#[test]
fn existing_generated_yaml_can_be_edited_in_place_without_changing_uid() {
    use std::{io::Write, process::Stdio};

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("deployment.yaml");
    let generated = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args([
            "onboard",
            "--generate-only",
            "--non-interactive",
            "--output",
        ])
        .arg(&path)
        .output()
        .unwrap();
    assert!(generated.status.success());
    let before = Document::parse(fs::read(&path).unwrap().as_slice()).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args(["onboard", "--generate-only", "--output"])
        .arg(&path)
        .arg("--edit")
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            b"i\nrejected-provider\nunsupported/model\nREJECTED_KEY\ni\nedited-provider\n\nEDITED_INFERENCE_KEY\na\n",
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Edit rejected: model: is not available"));
    assert!(stderr.contains("Provider: hosted-nvidia-prod"));
    let after = Document::parse(fs::read(&path).unwrap().as_slice()).unwrap();
    assert_eq!(after.metadata.uid, before.metadata.uid);
    assert_eq!(after.metadata.name, before.metadata.name);
    assert_eq!(after.spec.sandboxes[0].name, before.spec.sandboxes[0].name);
    assert_eq!(after.inference_provider().unwrap().name, "edited-provider");
    assert_eq!(after.credential_names(), ["EDITED_INFERENCE_KEY"]);
}

#[test]
fn exiting_review_does_not_publish_and_failed_publication_preserves_target() {
    use std::{io::Write, process::Stdio};

    let directory = tempfile::tempdir().unwrap();
    let exited = directory.path().join("exited.yaml");
    let mut child = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args(["onboard", "--generate-only", "--output"])
        .arg(&exited)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"\n\n\n\n\n\nx\n")
        .unwrap();
    assert!(child.wait().unwrap().success());
    assert!(!exited.exists());

    let target = directory.path().join("existing-directory");
    fs::create_dir(&target).unwrap();
    let failed = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args([
            "onboard",
            "--generate-only",
            "--non-interactive",
            "--output",
        ])
        .arg(&target)
        .output()
        .unwrap();
    assert!(!failed.status.success());
    assert!(target.is_dir());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);

    let missing_target = directory.path().join("missing-parent/deployment.yaml");
    let failed = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .args([
            "onboard",
            "--generate-only",
            "--non-interactive",
            "--output",
        ])
        .arg(&missing_target)
        .output()
        .unwrap();
    assert!(!failed.status.success());
    assert!(!missing_target.exists());
}
