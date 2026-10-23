// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The three-agent examples for an external Kubernetes or OpenShift gateway,
//! through the SDK and the bundle's CLI against the fixture gateway, which
//! reports OpenShell's Kubernetes driver.
use crate::deployment::Lifecycle;
use nemoclaw_sdk::config::Document;
use std::fs;

/// A model server's Service, whose name resolves only inside the cluster. It
/// takes no key.
const SERVICE: &str = "http://qwen.models.svc.cluster.local:8000/v1";

/// Apply `example` with its inference provider at the cluster's Service, then
/// check each agent's sandbox, policy, and configuration, an unchanged apply,
/// export and reapply, and destroy.
async fn three_agents_apply_export_reapply_and_destroy(example: &str) {
    let mut document = Document::parse(example.as_bytes()).unwrap();
    assert_eq!(document.spec.sandboxes.len(), 3);
    let provider = &mut document.spec.inference_providers[0];
    provider.endpoint = SERVICE.into();
    provider.credential = None;
    let lifecycle = Lifecycle::start_on_cluster(&document.yaml().unwrap()).await;
    let effects = lifecycle.apply().await;
    let state = lifecycle.directory.path().join("terraform.tfstate");
    let applied = fs::read(&state).unwrap();
    {
        let gateway = lifecycle.fixture.state.lock().unwrap();
        for sandbox in &lifecycle.document.spec.sandboxes {
            let key = format!("{}/{}", lifecycle.document.workspace(), sandbox.name);
            let observed = &gateway.sandboxes[&key];
            let id = &observed.metadata.as_ref().unwrap().id;
            // OpenShell decides which address the name may reach, so the rule
            // names the Service and grants no address.
            let policy = observed.spec.as_ref().unwrap().policy.as_ref().unwrap();
            let service: Vec<_> = policy
                .network_policies
                .values()
                .flat_map(|rule| &rule.endpoints)
                .filter(|endpoint| endpoint.host == "qwen.models.svc.cluster.local")
                .collect();
            assert_eq!(service.len(), 1, "{}: {policy:?}", sandbox.name);
            assert_eq!(service[0].port, 8000);
            assert!(service[0].allowed_ips.is_empty(), "{:?}", service[0]);
            let configuration = &gateway.fabric_configurations[id];
            assert_eq!(configuration["metadata"]["name"], sandbox.agent.name);
            assert_eq!(configuration["models"]["default"]["base_url"], SERVICE);
        }
        assert_eq!(gateway.sandboxes.len(), 3);
        assert_eq!(gateway.fabric_configurations.len(), 3);
    }
    assert!(
        lifecycle
            .deployment
            .apply(&lifecycle.document, &lifecycle.cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(lifecycle.fixture.state.lock().unwrap().effects, effects);
    nemoclaw_e2e::assert_same_deployment_state(&fs::read(&state).unwrap(), &applied);
    lifecycle.export_and_reapply_unchanged(effects).await;
    lifecycle.destroy();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn three_agents_on_a_kubernetes_gateway_apply_export_reapply_and_destroy() {
    three_agents_apply_export_reapply_and_destroy(include_str!(
        "../../../examples/kubernetes/external-gateway.yaml"
    ))
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn three_agents_on_an_openshift_gateway_apply_export_reapply_and_destroy() {
    three_agents_apply_export_reapply_and_destroy(include_str!(
        "../../../examples/openshift/external-gateway.yaml"
    ))
    .await;
}
