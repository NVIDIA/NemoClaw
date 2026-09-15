// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
use std::process::Command;
#[test]
fn runtime_requires_current_configuration_and_validates_it_before_work() {
    for (variable, expected) in [
        (
            "NEMOCLAW_RUNTIME_SPEC",
            "invalid pinned runtime specification",
        ),
        ("NEMOCLAW_SPARK_SPEC", "missing runtime specification"),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-runtime"))
            .env_remove("NEMOCLAW_RUNTIME_SPEC")
            .env_remove("NEMOCLAW_SPARK_SPEC")
            .env(variable, "not-json")
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8(output.stderr).unwrap().contains(expected));
    }
}
