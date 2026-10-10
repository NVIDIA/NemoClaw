// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[test]
fn a_relocated_benchmark_records_ci_identity_and_unknown_worktree_state() {
    use std::{
        fs,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };
    let root = std::env::temp_dir().join(format!(
        "gpuemit-provenance-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let sha = "1234567890abcdef1234567890abcdef12345678";
    let result = Command::new(env!("CARGO_BIN_EXE_gpu-codegen"))
        .current_dir(&root)
        .env("CANDIDATE_SHA", sha)
        .args([
            "--backend",
            "cpu",
            "--functions",
            "1",
            "--batch-functions",
            "1",
            "--repeats",
            "1",
            "--cpu-workers",
            "1",
            "--out-dir",
            "output",
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("output/report.json")).unwrap()).unwrap();
    assert_eq!(report["source_revision"], sha);
    assert_eq!(report["source_revision_origin"], "ci-environment-assertion");
    assert!(report["worktree_dirty"].is_null());
    fs::remove_dir_all(root).unwrap();
}
