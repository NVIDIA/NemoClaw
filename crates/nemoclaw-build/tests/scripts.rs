// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! NemoClaw's tooling is Rust; Python and shell remain only where the workload needs them.

use std::{collections::BTreeMap, path::Path, process::Command};

/// Why a script may exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reason {
    /// Runs inside an agent image, whose Fabric adapters already need Python.
    AgentImage,
    /// Runs inside a vLLM recipe image, or exercises that recipe's code.
    Recipe,
    /// Host-side tooling or a test fake still waiting to move to Rust. Remove,
    /// never add, entries with this reason.
    PendingRust,
}
use Reason::*;

const ALLOWED: &[(&str, Reason)] = &[
    // The Fabric host and its tests run with the image's adapter Python.
    ("image/fabric/backend.py", AgentImage),
    ("image/fabric/bridge_contract.py", AgentImage),
    ("image/fabric/catalog.py", AgentImage),
    ("image/fabric/dummy_backend.py", AgentImage),
    ("image/fabric/fabric-agent", AgentImage),
    ("image/fabric/fabric.py", AgentImage),
    ("image/fabric/openclaw_configuration.py", AgentImage),
    ("image/fabric/provenance.py", AgentImage),
    ("image/fabric/runtime_metadata.py", AgentImage),
    ("image/fabric/test_build.py", AgentImage),
    ("image/fabric/test_catalog_contract.py", AgentImage),
    ("image/fabric/test_openclaw_configuration.py", AgentImage),
    ("image/fabric/test_protocol.py", AgentImage),
    ("image/fabric/test_reference.py", AgentImage),
    ("image/fabric/test_runtime_contract.py", AgentImage),
    ("image/fabric/wheel_lock.py", AgentImage),
    ("image/hermes_security.py", AgentImage),
    ("image/qualify_native.py", AgentImage),
    ("image/test_agent_contract.py", AgentImage),
    ("image/test_image.py", AgentImage),
    ("image/test_openclaw_reconfiguration.py", AgentImage),
    // Recipe code runs in vLLM's Python environment; qwen38 adapts upstream code.
    ("crates/nemoclaw-e2e/fixtures/spark_preparation.py", Recipe),
    ("runtimes/qwen38/apply_patches.py", Recipe),
    ("runtimes/qwen38/prepare.py", Recipe),
    ("runtimes/qwen38/test_attribution.py", Recipe),
    ("runtimes/qwen38/test_prepare.py", Recipe),
    ("runtimes/qwen38/verify.py", Recipe),
    ("runtimes/qwen38/verify_packed.py", Recipe),
    ("runtimes/vllm/test_auth.py", Recipe),
    ("runtimes/vllm/test_download.py", Recipe),
    // Collected on SSH hosts with their python3; replace with fixed commands parsed in Rust.
    (
        "crates/nemoclaw-provider/src/hardware/ssh_capacity.py",
        PendingRust,
    ),
    (
        "crates/nemoclaw-provider/tests/fixtures/ssh_capacity.py",
        PendingRust,
    ),
    // Test fakes.
    (
        "crates/nemoclaw-build/src/runtime/image_fixture.sh",
        PendingRust,
    ),
    ("crates/nemoclaw-build/src/runtime_fixture.sh", PendingRust),
    (
        "crates/nemoclaw-e2e/tests/fixtures/cache_provider.py",
        PendingRust,
    ),
    (
        "crates/nemoclaw-e2e/tests/fixtures/remote_ssh.py",
        PendingRust,
    ),
    // CI orchestration: Brev, documentation publishing, and a developer replay tool.
    (
        "examples/onboarding-tui/scripts/replay_guided.py",
        PendingRust,
    ),
    ("tools/ci/brev_image.py", PendingRust),
    ("tools/ci/test_brev.py", PendingRust),
    ("tools/ci/test_brev_image.py", PendingRust),
    ("tools/ci/test_brev_phases.py", PendingRust),
    ("tools/docs/fern.py", PendingRust),
    ("tools/docs/test_fern.py", PendingRust),
    ("tools/e2e/brev-v1-guest.sh", PendingRust),
    ("tools/e2e/brev-v1-host.sh", PendingRust),
    ("tools/e2e/brev-v1-startup.sh", PendingRust),
];

/// Tracked files that are Python or shell, by extension or shebang.
fn scripts(root: &Path) -> Vec<String> {
    let output = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(root)
        .output()
        .expect("git lists tracked files");
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .split('\0')
        .filter(|name| !name.is_empty())
        .filter(|name| {
            let path = root.join(name);
            Path::new(name)
                .extension()
                .is_some_and(|extension| matches!(extension.to_str(), Some("py" | "sh" | "bash")))
                || std::fs::read(&path).is_ok_and(|bytes| {
                    bytes.starts_with(b"#!")
                        && bytes
                            .split(|byte| *byte == b'\n')
                            .next()
                            .is_some_and(|line| {
                                let line = String::from_utf8_lossy(line);
                                ["python", "sh", "bash"].iter().any(|shell| {
                                    line.split(['/', ' ']).any(|word| word.starts_with(shell))
                                })
                            })
                })
        })
        .map(str::to_owned)
        .collect()
}

#[test]
fn only_listed_scripts_exist_and_each_has_a_reason() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    if !root.join(".git").exists() {
        // Extracted source archives have no repository to list.
        return;
    }
    let tracked = scripts(&root);
    let allowed: BTreeMap<&str, Reason> = ALLOWED.iter().copied().collect();
    let unlisted: Vec<_> = tracked
        .iter()
        .filter(|name| !allowed.contains_key(name.as_str()))
        .collect();
    assert!(
        unlisted.is_empty(),
        "write new tooling and tests in Rust; Python belongs only inside images whose \
         workload runs on it. Unlisted scripts: {unlisted:#?}"
    );
    let stale: Vec<_> = allowed
        .keys()
        .filter(|name| !tracked.iter().any(|tracked| tracked == *name))
        .collect();
    assert!(
        stale.is_empty(),
        "remove deleted scripts from ALLOWED: {stale:#?}"
    );
}
