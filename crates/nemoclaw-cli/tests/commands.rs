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
fn supported_commands_are_top_level_and_destroy_preview_accepts_no_input_file() {
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    for command in ["plan", "apply", "export", "destroy"] {
        assert!(help.contains(command));
    }
    assert!(
        !Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
            .args(["config", "apply"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(
        !Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
            .args(["plan", "--destroy", "input.yaml"])
            .output()
            .unwrap()
            .status
            .success()
    );
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
