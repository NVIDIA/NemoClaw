// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{fs, process::Command};

#[test]
fn json_selection_does_not_turn_usage_errors_into_operation_results() {
    for args in [
        vec!["apply", "-o", "json", "--progress", "off"],
        vec!["destroy", "-o", "json", "--unknown-option"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let diagnostic = String::from_utf8(output.stderr).unwrap();
        assert!(diagnostic.contains("Usage:"), "{diagnostic}");
        assert!(serde_json::from_str::<serde_json::Value>(&diagnostic).is_err());
        assert!(!diagnostic.contains('\u{1b}'));
    }
}

#[test]
fn help_remains_text_and_documents_lifecycle_output_controls() {
    for operation in ["plan", "apply", "destroy"] {
        let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw"))
            .args([operation, "-o", "json", "--help"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let help = String::from_utf8(output.stdout).unwrap();
        for option in ["--output", "text", "json", "--progress", "--state-dir"] {
            assert!(
                help.contains(option),
                "{operation} help omits {option}: {help}"
            );
        }
        assert!(serde_json::from_str::<serde_json::Value>(&help).is_err());
    }
}

#[test]
fn failure_json_and_progress_stay_separate_when_either_stream_is_redirected() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("input.yaml");
    fs::write(
        &config,
        include_str!("../../../examples/openclaw-dashboard.yaml"),
    )
    .unwrap();
    for operation in ["plan", "apply", "destroy"] {
        for mode in ["auto", "plain", "off"] {
            for redirect_stdout in [false, true] {
                let state = directory.path().join("state-must-not-exist");
                let captured = directory.path().join("redirected-stream");
                let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw"));
                command.args([operation, "-o", "json", "--progress", mode, "--verbose"]);
                if operation != "destroy" {
                    command.arg(&config).arg("--non-interactive");
                }
                command
                    .arg("--bundle")
                    .arg(directory.path().join("missing-bundle"))
                    .arg("--state-dir")
                    .arg(&state);
                let destination = fs::File::create(&captured).unwrap();
                if redirect_stdout {
                    command.stdout(destination);
                } else {
                    command.stderr(destination);
                }
                let output = command.output().unwrap();
                assert_eq!(output.status.code(), Some(1));
                let (stdout, stderr) = if redirect_stdout {
                    assert!(output.stdout.is_empty());
                    (fs::read(&captured).unwrap(), output.stderr)
                } else {
                    assert!(output.stderr.is_empty());
                    (output.stdout, fs::read(&captured).unwrap())
                };
                let result: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
                assert_eq!(result["outcome"], "failed");
                assert!(
                    result["error"]["message"]
                        .as_str()
                        .unwrap()
                        .contains("bundle")
                );
                let progress = String::from_utf8(stderr).unwrap();
                assert!(!progress.contains('\u{1b}'), "{progress}");
                assert!(!progress.contains('\r'), "{progress}");
                if mode == "off" {
                    assert!(progress.is_empty(), "{progress}");
                } else {
                    assert!(progress.contains("bundle.verify"), "{progress}");
                    assert!(progress.contains("failed"), "{progress}");
                }
                assert!(!state.exists());
            }
        }
    }
}
