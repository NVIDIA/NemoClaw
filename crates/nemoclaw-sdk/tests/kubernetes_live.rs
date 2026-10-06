// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The managed Kubernetes gateway on a real cluster: install storage, the
//! development issuer and the gateway release; make one authenticated call
//! through the port forward; then remove the gateway and keep storage.
//!
//! `cargo ci live-kind` creates a kind cluster with Agent Sandbox installed
//! and runs this with:
//! - `NEMOCLAW_TEST_KUBECONFIG`: the cluster's kubeconfig file
//! - `NEMOCLAW_TEST_KUBE_CONTEXT`: its context
//! - `NEMOCLAW_TEST_HELM`: the pinned helm executable

use nemoclaw_provider::openshell::{OpenShell, Secrets};
use nemoclaw_sdk::{
    ObservationError,
    config::{ComputeDriver, Credential, ExternalGateway, Gateway, TLS},
    kubernetes::{
        CA_ENV, CERT_ENV, ClusterTarget, GATEWAY_KIND, KEY_ENV, STORAGE_KIND, Spec, TOKEN_ENV,
        connect, operations::Operations, server,
    },
};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc};

struct Values(BTreeMap<String, String>);
impl Secrets for Values {
    fn resolve(&self, key: &str) -> Result<String, ObservationError> {
        self.0
            .get(key)
            .cloned()
            .ok_or(ObservationError::Authentication)
    }
}

fn required(name: &str) -> String {
    std::env::var(name)
        .unwrap_or_else(|_| panic!("{name} must name the test cluster; run cargo ci live-kind"))
}

#[tokio::test]
#[ignore = "needs a Kubernetes cluster with Agent Sandbox; run through cargo ci live-kind"]
async fn the_gateway_installs_authenticates_and_is_removed_keeping_storage() {
    let target = ClusterTarget {
        kubeconfig: required("NEMOCLAW_TEST_KUBECONFIG").into(),
        context: required("NEMOCLAW_TEST_KUBE_CONTEXT"),
    };
    let mut owner = [0u8; 16];
    getrandom::fill(&mut owner).unwrap();
    owner[6] = (owner[6] & 0x0f) | 0x40;
    owner[8] = (owner[8] & 0x3f) | 0x80;
    let hex: String = owner.iter().map(|byte| format!("{byte:02x}")).collect();
    let owner = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    let workspace = &hex[..16];
    let namespace = format!("nc-live-{workspace}");
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let spec = |kind: &str| -> Spec {
        serde_json::from_value(json!({
            "layout": 1, "kind": kind, "name": format!("nc-{workspace}-gateway"), "owner": owner,
            "generation": "0123456789abcdef0123456789abcdef",
            "settings": {
                "runtime": {"provider": "kubernetes"},
                "endpoint": format!("https://127.0.0.1:{port}"),
                "kubernetes": {
                    "kubeconfig": {"env": "NEMOCLAW_TEST_KUBECONFIG"},
                    "context": target.context, "namespace": namespace,
                    "authentication": {"profile": "development"}
                }
            }
        }))
        .unwrap()
    };
    let state = tempfile::tempdir().unwrap();
    let operations = Operations {
        server: server(&target).unwrap(),
        client: connect(&target).await.unwrap(),
        helm: required("NEMOCLAW_TEST_HELM").into(),
        kubeconfig: target.kubeconfig.clone(),
        state: state.path().join("kubernetes"),
    };

    let storage = operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    assert_eq!(storage.running, Some(true));
    let gateway = operations.ensure(&spec(GATEWAY_KIND), None).await.unwrap();
    assert_eq!(
        gateway.running,
        Some(true),
        "the gateway release became ready"
    );

    // One authenticated call: GetGatewayInfo needs a bearer token with the
    // config:read scope and the platform admin role, over mutual TLS.
    {
        let connection = operations.connect(&spec(GATEWAY_KIND)).await.unwrap();
        let reference = |env: &str| Credential { env: env.into() };
        let gateway = Gateway::External(ExternalGateway {
            endpoint: connection.endpoint().to_owned(),
            credential: Some(reference(TOKEN_ENV)),
            tls: Some(TLS {
                ca: reference(CA_ENV),
                certificate: reference(CERT_ENV),
                key: reference(KEY_ENV),
            }),
            ..Default::default()
        });
        let client =
            OpenShell::connect(&gateway, Arc::new(Values(connection.environment()))).unwrap();
        client
            .verify_gateway(ComputeDriver::Kubernetes)
            .await
            .expect("the gateway accepts the development token");

        // A token signed by another issuer's key is refused.
        let other = tempfile::tempdir().unwrap();
        let foreign = nemoclaw_sdk::kubernetes::auth::Development::new(
            other.path().join("auth"),
            &format!("nc-{workspace}-gateway"),
            &namespace,
            &owner,
        )
        .ensure()
        .unwrap()
        .token(time::OffsetDateTime::now_utc().unix_timestamp());
        let mut forged = connection.environment();
        forged.insert(TOKEN_ENV.into(), foreign);
        let client = OpenShell::connect(&gateway, Arc::new(Values(forged))).unwrap();
        assert!(
            client.gateway_capabilities().await.is_err(),
            "a token from an unknown key is refused"
        );
    }

    operations
        .remove(&spec(GATEWAY_KIND), gateway.id.as_deref())
        .await
        .unwrap();
    let removed = operations.read(&spec(GATEWAY_KIND), None).await.unwrap();
    assert_eq!(removed.id, None, "the gateway release is gone");
    let kept = operations
        .read(&spec(STORAGE_KIND), storage.id.as_deref())
        .await
        .unwrap();
    assert_eq!(kept.id, storage.id, "storage is kept");

    // A second apply reuses the kept storage and installs a new release.
    let reinstalled = operations.ensure(&spec(GATEWAY_KIND), None).await.unwrap();
    assert_eq!(reinstalled.running, Some(true));
    operations
        .remove(&spec(GATEWAY_KIND), reinstalled.id.as_deref())
        .await
        .unwrap();
}

/// A full deployment on a real cluster through the public SDK: the managed
/// gateway, then an agent sandbox from the UID 10001 image. Apply stops at
/// the agent's health check, which the pinned Fabric reports as unsupported
/// (#12443); destroy then removes everything but the gateway's storage.
///
/// `cargo ci live-kind` also provides:
/// - `NEMOCLAW_TEST_BUNDLE`: the native bundle
/// - `NEMOCLAW_TEST_AGENT_IMAGE`: the agent image by digest, loaded into kind
/// - `NEMOCLAW_TEST_AGENT_HARNESS`: its Fabric adapter
/// - `NEMOCLAW_TEST_AGENT_METADATA`: its metadata bundle
#[tokio::test]
#[ignore = "needs a Kubernetes cluster with Agent Sandbox and a loaded agent image; run through cargo ci live-kind"]
async fn an_agent_sandbox_reaches_its_health_check_and_destroy_keeps_storage() {
    use nemoclaw_sdk::{CancellationToken, Deployment, Error, config::Document};
    let mut uid = [0u8; 16];
    getrandom::fill(&mut uid).unwrap();
    uid[6] = (uid[6] & 0x0f) | 0x40;
    uid[8] = (uid[8] & 0x3f) | 0x80;
    let hex: String = uid.iter().map(|byte| format!("{byte:02x}")).collect();
    let uid = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let yaml = format!(
        "apiVersion: nemoclaw.nvidia.com/v1alpha1
kind: NemoClawConfig
metadata:
  name: live-kind-agent
  uid: {uid}
spec:
  gateway:
    management: managed
    runtime:
      provider: kubernetes
    endpoint: https://127.0.0.1:{port}
    kubernetes:
      kubeconfig: {{env: NEMOCLAW_TEST_KUBECONFIG}}
      context: {context}
      namespace: nc-live-{namespace}
      authentication: {{profile: development}}
  inferenceProviders:
    - name: hosted
      provider: openai
      endpoint: https://inference.example.test/v1
  sandboxes:
    - name: assistant
      image:
        ref: {image}
        metadata: {{env: NEMOCLAW_TEST_AGENT_METADATA}}
      network:
        tier: isolated
      harness:
        kind: {harness}
      agent:
        name: main
        inference:
          routes:
            - name: primary
              providerRef: hosted
              overrides:
                model: fixture-model
                settings:
                  model_metadata:
                    api: openai-completions
                    contextWindow: 8192
                    maxTokens: 2048
                    reasoning: false
                    input:
                    - text
",
        context = required("NEMOCLAW_TEST_KUBE_CONTEXT"),
        namespace = &hex[..12],
        image = required("NEMOCLAW_TEST_AGENT_IMAGE"),
        harness = required("NEMOCLAW_TEST_AGENT_HARNESS"),
    );
    let document = Document::parse(yaml.as_bytes()).unwrap();
    let state = tempfile::tempdir().unwrap();
    let deployment = Deployment::new(
        state.path(),
        std::path::Path::new(&required("NEMOCLAW_TEST_BUNDLE")),
    );
    let cancel = CancellationToken::new();

    let error = deployment
        .apply(&document, &cancel)
        .await
        .expect_err("the agent's health is unsupported at this Fabric pin");
    match &error {
        Error::Execution {
            postcondition_failures: Some(failures),
            ..
        } => assert_eq!(
            failures,
            &["data.nemoclaw_sandbox_readiness.assistant".to_owned()],
            "apply must stop only at the agent's health check"
        ),
        other => panic!("apply must stop at the agent's health check, not earlier: {other}"),
    }

    let destroyed = deployment.destroy(&cancel).await.unwrap();
    for change in &destroyed.changes {
        assert!(
            !change.resource.contains("kubernetes_storage"),
            "destroy keeps the gateway's storage: {}",
            change.resource
        );
    }
}
