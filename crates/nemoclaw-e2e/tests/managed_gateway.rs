// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The managed gateway's runtime with a real gateway, Docker, both providers,
//! and the bundled OpenTofu. The test plans and applies only the runtime
//! through the SDK's `test-scenarios` setup, so it creates no sandboxes, then
//! exercises the public `plan_destroy` and `destroy`.

use nemoclaw_sdk::{
    CancellationToken, Deployment,
    config::{ComputeDriver, Document, Gateway},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

/// The deployment's OpenTofu state.
fn state(directory: &Path) -> Value {
    serde_json::from_slice(&fs::read(directory.join("terraform.tfstate")).unwrap()).unwrap()
}

/// Identities of the deployment's managed resources, by address.
fn bindings(directory: &Path) -> BTreeMap<String, String> {
    state(directory)["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|resource| resource["mode"] == "managed")
        .map(|resource| {
            (
                format!(
                    "{}.{}",
                    resource["type"].as_str().unwrap(),
                    resource["name"].as_str().unwrap()
                ),
                resource["instances"][0]["attributes"]["id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            )
        })
        .collect()
}

const STORAGE: &str = "openshell_gateway_storage.runtime";

#[tokio::test]
#[ignore = "creates and removes only an explicitly configured test gateway; retains its storage"]
async fn managed_gateway_plan_apply_noop_destroy_and_recovery_use_real_opentofu() {
    let path =
        |name| PathBuf::from(std::env::var_os(name).expect("explicit managed qualification path"));
    let mut document =
        Document::parse(fs::File::open(path("NEMOCLAW_TEST_GATEWAY_DOCUMENT")).unwrap()).unwrap();
    assert!(matches!(document.spec.gateway, Gateway::Managed(_)));
    assert!(
        document
            .spec
            .inference_providers
            .values()
            .all(|provider| provider.service_ref.is_none())
    );
    assert!(document.spec.services.is_empty());
    let directory = path("NEMOCLAW_TEST_GATEWAY_STATE");
    let deployment = Deployment::new(&directory, &path("NEMOCLAW_TEST_BUNDLE"));
    let cancel = CancellationToken::new();
    let engine = nemoclaw_provider::docker::Engine::connect(
        &document.spec.gateway.as_managed().unwrap().engine,
    )
    .unwrap();
    let name = format!("{}-gateway", document.workspace());
    let container_before = engine.container(&name).await.unwrap().map(|c| c.id);
    let volume_before = engine
        .volume(&format!("{name}-data"))
        .await
        .unwrap()
        .map(|v| v.created_at);
    deployment
        .scenario_runtime_stage(&document, false, &cancel)
        .await
        .unwrap();
    assert_eq!(
        engine.container(&name).await.unwrap().map(|c| c.id),
        container_before,
        "plan created a runtime"
    );
    assert_eq!(
        engine
            .volume(&format!("{name}-data"))
            .await
            .unwrap()
            .map(|v| v.created_at),
        volume_before,
        "plan created storage"
    );
    deployment
        .scenario_runtime_stage(&document, true, &cancel)
        .await
        .unwrap();
    let first = bindings(&directory);
    let readiness = state(&directory)["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|resource| resource["mode"] == "data" && resource["type"] == "openshell_gateway")
        .expect("runtime apply must record provider-owned readiness")
        .clone();
    assert_eq!(readiness["instances"][0]["attributes"]["compatible"], true);
    let docker = document.spec.gateway.runtime().provider == ComputeDriver::Docker;
    let compute = if docker {
        "docker_container.managed_gateway_runtime"
    } else {
        "openshell_podman_gateway.runtime"
    };
    assert_eq!(first.len(), if docker { 3 } else { 2 });
    assert!(
        !deployment
            .scenario_runtime_stage(&document, true, &cancel)
            .await
            .unwrap(),
        "an unchanged runtime apply has no changes"
    );
    assert_eq!(bindings(&directory), first);
    if docker {
        let api = bollard::Docker::connect_with_unix(
            engine.endpoint(),
            120,
            bollard::API_DEFAULT_VERSION,
        )
        .unwrap();
        for remove in [false, true] {
            let old = engine.container(&name).await.unwrap().unwrap().id.unwrap();
            api.stop_container(&old, None).await.unwrap();
            if remove {
                api.remove_container(&old, None).await.unwrap();
            }
            deployment
                .scenario_runtime_stage(&document, true, &cancel)
                .await
                .unwrap();
            let current = engine.container(&name).await.unwrap().unwrap();
            assert_eq!(current.state.unwrap().running, Some(true));
            if remove {
                assert_ne!(current.id.as_deref(), Some(old.as_str()));
            }
            assert_eq!(bindings(&directory)[STORAGE], first[STORAGE]);
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let old = engine.container(&name).await.unwrap().unwrap().id;
        *document.spec.gateway.endpoint_mut() = format!("http://127.0.0.1:{port}");
        deployment
            .scenario_runtime_stage(&document, true, &cancel)
            .await
            .unwrap();
        assert_ne!(engine.container(&name).await.unwrap().unwrap().id, old);
        assert_eq!(bindings(&directory)[STORAGE], first[STORAGE]);
        let state_path = directory.join("terraform.tfstate");
        let prior = fs::read(&state_path).unwrap();
        let data_path = engine
            .volume(&format!("{name}-data"))
            .await
            .unwrap()
            .unwrap()
            .mountpoint;
        let helper = engine
            .container(&format!("{name}-initialize"))
            .await
            .unwrap()
            .unwrap()
            .id
            .unwrap();
        let credentials = format!("{data_path}/state/openshell/gateway/credentials");
        let key = engine
            .read_file(
                &helper,
                &format!("{credentials}/key-encryption-key.bin"),
                32,
            )
            .await
            .unwrap()
            .unwrap();
        let mut replacement = key.clone();
        replacement[0] ^= 1;
        engine
            .write_files(
                &helper,
                &credentials,
                &[("key-encryption-key.bin", &replacement, 0o600)],
            )
            .await
            .unwrap();
        assert!(
            deployment
                .scenario_runtime_stage(&document, true, &cancel)
                .await
                .is_err()
        );
        assert_eq!(fs::read(state_path).unwrap(), prior);
        engine
            .write_files(
                &helper,
                &credentials,
                &[("key-encryption-key.bin", &key, 0o600)],
            )
            .await
            .unwrap();
        deployment
            .scenario_runtime_stage(&document, true, &cancel)
            .await
            .unwrap();
    }
    // Preview must remain read-only.
    let plan = deployment.plan_destroy(&cancel).await.unwrap();
    assert_eq!(plan.changes.len(), if docker { 2 } else { 1 });
    assert_eq!(plan.retained, vec![STORAGE]);
    deployment.destroy(&cancel).await.unwrap();
    assert!(engine.container(&name).await.unwrap().is_none());
    let refusal = deployment.export(&cancel).await.unwrap_err().to_string();
    assert!(
        refusal.contains("cannot export a destroyed deployment"),
        "{refusal}"
    );
    deployment
        .scenario_runtime_stage(&document, true, &cancel)
        .await
        .unwrap();
    let recovered = bindings(&directory);
    assert_eq!(recovered[STORAGE], first[STORAGE]);
    assert_ne!(recovered[compute], first[compute]);
    deployment.destroy(&cancel).await.unwrap();
    assert!(engine.container(&name).await.unwrap().is_none());
}
