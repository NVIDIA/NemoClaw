// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{path::PathBuf, process::Command};

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn v0_capture_runner_is_issue_gated_before_touching_a_checkout() {
    let script = repository_root().join("tools/validation/openclaw-hosted-v0-capture.sh");
    let output = Command::new("bash")
        .arg(&script)
        .env_remove("NEMOCLAW_RUN_LIVE_HOSTED_PARITY")
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("NEMOCLAW_RUN_LIVE_HOSTED_PARITY=issue-11810"));
    assert!(!stderr.contains("NVIDIA_INFERENCE_API_KEY"));

    let source = std::fs::read_to_string(script).unwrap();
    let hash_check = source.find("expected_overlay_sha").unwrap();
    let apply = source.find("git apply --check").unwrap();
    assert!(hash_check < apply);
}

#[test]
fn v0_overlay_records_probe_and_export_before_target_completion() {
    let root = repository_root();
    let revision = "f47724f29838fe08898993fad1c8c6b7fcb3e080";
    let relative = "test/e2e/live/registry-targets.test.ts";
    let original = Command::new("git")
        .current_dir(&root)
        .args(["show", &format!("{revision}:{relative}")])
        .output()
        .unwrap();
    assert!(original.status.success());
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join(relative);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, original.stdout).unwrap();
    let applied = Command::new("git")
        .current_dir(directory.path())
        .args([
            "apply",
            root.join("tools/validation/openclaw-hosted-v0-capture.patch")
                .to_str()
                .unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    let patched = std::fs::read_to_string(target).unwrap();

    let probe = patched.rfind("runOpenClawAgentAssertion").unwrap();
    let export = patched.find("config\", \"export").unwrap();
    let completion = patched.rfind("artifacts.target.complete").unwrap();
    assert!(probe < export && export < completion);
    assert!(patched.contains("NEMOCLAW_11810_V0_OK"));
    assert!(patched.contains("NEMOCLAW_11810_CAPTURE_DIR"));
    assert!(patched.contains("redactionValues: [apiKey]"));

    let proof = std::fs::read_to_string(root.join("tools/validation/openclaw-hosted-v0-proof.mjs"))
        .unwrap();
    assert!(proof.contains("architecture: command(\"uname\", [\"-m\"]),"));
}
