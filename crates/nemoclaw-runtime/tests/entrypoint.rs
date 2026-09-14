// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
use std::process::Command;
#[test]
fn renamed_executable_validates_both_current_and_legacy_configuration_before_work() {
    for variable in ["NEMOCLAW_RUNTIME_SPEC", "NEMOCLAW_SPARK_SPEC"] {
        let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-runtime"))
            .env_remove("NEMOCLAW_RUNTIME_SPEC")
            .env_remove("NEMOCLAW_SPARK_SPEC")
            .env(variable, "not-json")
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
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-runtime"))
        .env("NEMOCLAW_RUNTIME_SPEC", "current")
        .env("NEMOCLAW_SPARK_SPEC", "legacy")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("conflicting runtime specifications")
    );
}
