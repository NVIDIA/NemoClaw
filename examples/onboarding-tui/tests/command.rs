// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{fs, process::Command};

#[test]
fn non_terminal_input_cannot_start_or_overwrite_the_example() {
    let directory = tempfile::tempdir().unwrap();
    let output_path = directory.path().join("deployment.yaml");
    fs::write(&output_path, "complete prior file").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-onboarding"))
        .args(["--output"])
        .arg(&output_path)
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "the example onboarding TUI requires a terminal on stdin\n"
    );
    assert_eq!(
        fs::read_to_string(output_path).unwrap(),
        "complete prior file"
    );
}

#[test]
fn help_describes_a_generation_only_example() {
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-onboarding"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("example terminal frontend"));
    assert!(stdout.contains("does not resolve credentials, plan, or apply"));
    for unsupported in ["--state-dir", "--bundle", "--apply"] {
        assert!(!stdout.contains(unsupported));
    }
}
