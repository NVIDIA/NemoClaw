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
fn prototype_bundle_flag_selects_an_explicit_bundle() {
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
