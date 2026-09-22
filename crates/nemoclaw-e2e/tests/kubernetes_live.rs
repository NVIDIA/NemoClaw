// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    CancellationToken, Deployment,
    config::{ComputeDriver, Document, HarnessKind},
};
use std::{fs, path::PathBuf, process::Command};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "mutates an explicitly configured owned Kubernetes gateway and invokes its model"]
async fn owned_kind_stack_applies_invokes_exports_reapplies_and_destroys() {
    let config = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_KUBERNETES_CONFIG").expect("explicit config required"),
    );
    let state = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_KUBERNETES_STATE")
            .expect("explicit new state directory required"),
    );
    let bundle =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("verified bundle required"));
    assert!(config.is_absolute() && state.is_absolute() && bundle.is_absolute());
    let document = Document::parse(fs::File::open(config).unwrap()).unwrap();
    assert_eq!(document.metadata.name, "kind-agent");
    assert_eq!(document.spec.sandboxes.len(), 1);
    let sandbox = &document.spec.sandboxes[0];
    assert_eq!(sandbox.runtime.provider, ComputeDriver::Kubernetes);
    assert_eq!(
        document.sandbox_harness(sandbox).unwrap().kind,
        HarnessKind::OpenClaw
    );
    assert!(document.spec.services.is_empty());
    assert!(
        !state.exists(),
        "retain previous state for recovery; never adopt an existing deployment"
    );
    fs::create_dir(&state).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    }
    // Keep this directory after both success and failure. A lost response must
    // never discard the only deployment identity and recovery information.
    let deployment = Deployment::new(&state, &bundle);
    let cancel = CancellationToken::new();
    deployment.plan(&document, &cancel).await.unwrap();
    deployment.apply(&document, &cancel).await.unwrap();
    // The SDK validates the assistant response, allowing only FOUR with its
    // documented punctuation/case normalization; it rejects echoed prompts.
    let response = nemoclaw_e2e::verify_agent(&document, &state).await;
    println!("Verified agent response: {response}");

    let exported_path = state.join("export.yaml");
    let result = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["--bundle"])
    .arg(&bundle)
    .arg("--state-dir")
    .arg(&state)
    .args(["export", "--output"])
    .arg(&exported_path)
    .output()
    .unwrap();
    assert!(
        result.status.success(),
        "CLI export failed; deployment state retained"
    );
    let exported = Document::parse(fs::File::open(&exported_path).unwrap()).unwrap();
    assert_eq!(exported.digest(), document.digest());
    let unchanged = deployment.apply(&exported, &cancel).await.unwrap();
    assert!(
        unchanged.changes.is_empty(),
        "unchanged Kubernetes apply must preserve resource identities"
    );

    let result = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["--bundle"])
    .arg(&bundle)
    .arg("--state-dir")
    .arg(&state)
    .arg("destroy")
    .output()
    .unwrap();
    assert!(
        result.status.success(),
        "CLI destroy failed; deployment state retained"
    );
}
