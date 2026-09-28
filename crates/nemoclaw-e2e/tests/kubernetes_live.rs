// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    CancellationToken, Deployment,
    config::{ComputeDriver, Document},
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn resource_ids(directory: &Path) -> BTreeMap<String, String> {
    let mut ids = BTreeMap::new();
    for stage in ["terraform.tfstate", "runtime/terraform.tfstate"] {
        let path = directory.join(stage);
        if stage.starts_with("runtime/") && !path.exists() {
            continue;
        }
        let state: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        for resource in state["resources"].as_array().unwrap() {
            if resource["mode"] == "data" {
                continue;
            }
            assert_eq!(resource["mode"], "managed");
            let instances = resource["instances"].as_array().unwrap();
            assert_eq!(instances.len(), 1);
            let id = instances[0]["attributes"]["id"].as_str().unwrap();
            assert!(!id.is_empty());
            let address = format!(
                "{stage}:{}.{}",
                resource["type"].as_str().unwrap(),
                resource["name"].as_str().unwrap()
            );
            assert!(ids.insert(address, id.into()).is_none());
        }
    }
    ids
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "invokes the model of an explicitly selected existing owned Kubernetes deployment"]
async fn owned_kubernetes_agent_response_from_retained_state() {
    let config = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_KUBERNETES_CONFIG").expect("explicit config required"),
    );
    let state = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_KUBERNETES_STATE")
            .expect("explicit retained state required"),
    );
    assert!(config.is_absolute() && state.is_absolute());
    let document = Document::parse(fs::File::open(config).unwrap()).unwrap();
    assert!(!document.spec.sandboxes.is_empty());
    for sandbox in &document.spec.sandboxes {
        assert_eq!(sandbox.runtime.provider, ComputeDriver::Kubernetes);
    }
    assert!(state.join("intent.json").is_file());
    for (sandbox, response) in nemoclaw_e2e::verify_agents(&document, &state).await {
        println!("Verified agent response for {sandbox}: {response}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "mutates an explicitly configured owned Kubernetes gateway and invokes its model"]
async fn owned_kubernetes_gateway_applies_invokes_exports_reapplies_and_destroys() {
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
    assert!(!document.spec.sandboxes.is_empty());
    for sandbox in &document.spec.sandboxes {
        assert_eq!(sandbox.runtime.provider, ComputeDriver::Kubernetes);
        assert_eq!(
            document.sandbox_harness(sandbox).unwrap().kind.as_str(),
            "nvidia.fabric.openclaw"
        );
    }
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
    let original_ids = resource_ids(&state);
    // This explicit E2E invocation goes through the existing Fabric runtime.
    // Its adapter-specific test oracle accepts FOUR, never an echoed prompt;
    // it does not introduce a model-only probe or SDK health contract.
    let responses = nemoclaw_e2e::verify_agents(&document, &state).await;
    assert_eq!(responses.len(), document.spec.sandboxes.len());
    for (sandbox, response) in responses {
        println!("Verified agent response for {sandbox}: {response}");
    }
    let no_op = deployment.plan(&document, &cancel).await.unwrap();
    assert!(
        no_op.changes.is_empty(),
        "applied Kubernetes deployment must plan no changes"
    );
    assert_eq!(resource_ids(&state), original_ids);

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
    assert_eq!(resource_ids(&state), original_ids);
    let unchanged = deployment.apply(&exported, &cancel).await.unwrap();
    assert!(
        unchanged.changes.is_empty(),
        "unchanged Kubernetes apply must preserve resource identities"
    );
    assert_eq!(resource_ids(&state), original_ids);

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
    let destroyed: serde_json::Value =
        serde_json::from_slice(&fs::read(state.join("terraform.tfstate")).unwrap()).unwrap();
    for resource in destroyed["resources"].as_array().unwrap() {
        if matches!(
            resource["type"].as_str(),
            Some(
                "nemoclaw_sandbox"
                    | "nemoclaw_provider"
                    | "nemoclaw_provider_profile"
                    | "nemoclaw_agent_configuration"
            )
        ) {
            assert!(
                resource["instances"].as_array().unwrap().is_empty(),
                "destroy must remove every sandbox and provider registration"
            );
        }
    }
    let intent: serde_json::Value =
        serde_json::from_slice(&fs::read(state.join("intent.json")).unwrap()).unwrap();
    assert_eq!(intent["destroyed"], true);
}
