// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::{fs, path::Path, process::Command};

fn generate(directory: &Path, check: bool) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"));
    command.current_dir(directory).arg("schema");
    if check {
        command.arg("--check");
    }
    command.output().unwrap()
}

#[test]
fn schema_generation_is_repeatable_and_check_rejects_missing_or_stale_output() {
    let directory = tempfile::tempdir().unwrap();
    assert!(!generate(directory.path(), true).status.success());
    assert!(
        !directory.path().join("schemas").exists(),
        "check must not create files"
    );
    let result = generate(directory.path(), false);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let path = directory
        .path()
        .join("schemas/nemoclaw-v1alpha1.schema.json");
    let first = fs::read(&path).unwrap();
    let schema: serde_json::Value = serde_json::from_slice(&first).unwrap();
    assert_eq!(
        schema["$schema"],
        "https://json-schema.org/draft/2020-12/schema"
    );
    assert_eq!(schema["$id"], "urn:nemoclaw:config:v1alpha1");
    assert!(generate(directory.path(), false).status.success());
    assert_eq!(fs::read(&path).unwrap(), first);
    assert!(generate(directory.path(), true).status.success());
    fs::write(&path, b"{}\n").unwrap();
    let stale = generate(directory.path(), true);
    assert!(!stale.status.success());
    assert!(
        String::from_utf8_lossy(&stale.stderr).contains("schemas/nemoclaw-v1alpha1.schema.json")
    );
    assert_eq!(fs::read(&path).unwrap(), b"{}\n");
}
