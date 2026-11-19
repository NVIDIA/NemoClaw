// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(all(target_os = "linux", feature = "execution"))]
use std::process::Command;
#[test]
fn runtime_validates_its_configuration_before_work() {
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-runtime"))
        .env("NEMOCLAW_RUNTIME_SPEC", "not-json")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("invalid pinned runtime specification")
    );
}

#[test]
fn runtime_reports_its_version_without_a_specification() {
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-runtime"))
        .arg("--version")
        .env_remove("NEMOCLAW_RUNTIME_SPEC")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("nemoclaw-runtime {}\n", env!("CARGO_PKG_VERSION"))
    );
}
