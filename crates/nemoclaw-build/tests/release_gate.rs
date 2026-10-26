// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Staging lists the agent images the select job evaluated.

#[cfg(unix)]
#[test]
fn staging_lists_the_selected_catalog_instead_of_its_own_bake_output() {
    use serde_json::{Value, json};
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};
    let workflow: Value =
        serde_saphyr::from_str(include_str!("../../../.github/workflows/release.yml")).unwrap();
    let script = workflow["jobs"]["stage"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "List the release images")
        .unwrap()["run"]
        .as_str()
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    for (name, script) in [
        (
            "docker",
            "#!/bin/sh\nprintf '%s\\n' '{\"target\":{\"controller-only\":{}}}'\n",
        ),
        (
            "cargo",
            "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$CONTROLLER_BIN\" \"$@\"\n",
        ),
    ] {
        let path = bin.join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let candidate = "a".repeat(40);
    let source = "b".repeat(40);
    let catalog = json!({"candidate_revision":candidate,"source_revision":source,"agents":["candidate-only","hermes"]});
    let output_file = root.path().join("job-output");
    let output = Command::new("/bin/bash")
        .args(["-euo", "pipefail", "-c", script])
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .env("RUNNER_TEMP", root.path())
        .env("GITHUB_OUTPUT", &output_file)
        .env("CONTROLLER_BIN", env!("CARGO_BIN_EXE_nemoclaw-build"))
        .env("CANDIDATE_CATALOG", catalog.to_string())
        .env("CANDIDATE_REVISION", &candidate)
        .env("SOURCE", &source)
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let outputs = fs::read_to_string(output_file).unwrap();
    assert!(
        outputs
            .lines()
            .any(|line| line == "agents=candidate-only hermes"),
        "{outputs}"
    );
    assert!(
        outputs
            .lines()
            .any(|line| line == "names=candidate-only hermes ollama-proxy vllm ollama"),
        "{outputs}"
    );
    assert!(!outputs.contains("controller-only"), "{outputs}");
}
