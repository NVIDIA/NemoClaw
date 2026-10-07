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
