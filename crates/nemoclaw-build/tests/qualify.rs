// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The container `cargo images qualify` runs the reference runtime contract in.

use nemoclaw_build::images::qualify_arguments;
use std::path::Path;

/// The reference runtime runs as an OpenShell sandbox would run it: offline,
/// read-only, with only its sandbox storage writable. Nothing else is mounted:
/// Fabric's native adapters are Fabric's to test.
#[test]
fn the_reference_contract_runs_offline_read_only_in_sandbox_storage() {
    let arguments = qualify_arguments(Path::new("/repo"), "name", "sha256:image");
    for required in ["--network=none", "--read-only", "--runtime=runc"] {
        assert!(
            arguments.iter().any(|argument| argument == required),
            "{required}"
        );
    }
    assert!(
        arguments
            .windows(2)
            .any(|pair| pair[0] == "-e" && pair[1] == "HOME=/sandbox")
    );
    assert!(
        arguments
            .windows(2)
            .any(|pair| pair[0] == "--workdir" && pair[1] == "/sandbox")
    );
    let mounts: Vec<&str> = arguments
        .windows(2)
        .filter(|pair| pair[0] == "--mount")
        .map(|pair| pair[1].as_str())
        .collect();
    let suite = Path::new("/repo")
        .join("image")
        .join("test_agent_contract.py");
    assert_eq!(
        mounts,
        [format!(
            "type=bind,src={},dst=/test.py,readonly",
            suite.display()
        )]
    );
    assert!(
        !arguments
            .iter()
            .any(|argument| argument.contains("FABRIC_NATIVE"))
    );
    assert_eq!(arguments.last().map(String::as_str), Some("/test.py"));
}
