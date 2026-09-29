// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::process::Command;

#[test]
fn runtime_build_does_not_resolve_deployment_transports() {
    for execution in [false, true] {
        let mut cargo = Command::new(env!("CARGO"));
        cargo.current_dir(env!("CARGO_MANIFEST_DIR")).args([
            "tree",
            "--offline",
            "--locked",
            "-p",
            "nemoclaw-runtime",
            "--edges",
            "normal",
            "--prefix",
            "none",
            "--format",
            "{p}",
            "--no-default-features",
        ]);
        if execution {
            cargo.args(["--features", "execution"]);
        }
        let output = cargo.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let graph = String::from_utf8(output.stdout).unwrap();
        for package in [
            "nemoclaw-sdk",
            "nemoclaw-provider",
            "openshell",
            "nemo-fabric",
            "bollard",
            "tonic",
        ] {
            assert!(
                !graph.lines().any(|line| line.starts_with(package)),
                "{package} in runtime closure"
            );
        }
        if !execution {
            assert!(!graph.contains("process-wrap"));
        }
    }
}
