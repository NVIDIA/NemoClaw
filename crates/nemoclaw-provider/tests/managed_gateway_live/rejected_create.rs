// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The pinned OpenShell persists nothing when it rejects a sandbox create as an
//! invalid argument. NemoClaw clears a deployment's pending creation on that
//! rejection (`docs/build-deploy/usage.md`), so a gateway that kept the sandbox
//! behind an `InvalidArgument` would leave a resource that no record tracks.

use super::*;
use openshell_sdk::{SdkError, raw::proto};

#[tokio::test]
#[ignore = "requires a fresh owned gateway document and pinned local images; starts a gateway and sends one rejected sandbox create, retains gateway storage"]
async fn an_invalid_argument_sandbox_create_persists_no_sandbox() {
    let spec = gateway_spec("NEMOCLAW_TEST_GATEWAY_DOCUMENT");
    let engine = Engine::connect(spec.engine()).unwrap();
    let api = Docker::connect_with_unix(spec.engine(), 120, bollard::API_DEFAULT_VERSION).unwrap();
    spec.validate_runtime().unwrap();
    assert_eq!(spec.image(), DEFAULT_GATEWAY_IMAGE);
    assert_eq!(spec.compute_driver, ComputeDriver::Docker);
    assert!(spec.process.is_none());
    for name in [&spec.name, &format!("{}-initialize", spec.name)] {
        assert!(engine.container(name).await.unwrap().is_none());
    }
    assert!(engine.volume(&spec.volume()).await.unwrap().is_none());
    assert!(engine.network(&spec.network()).await.unwrap().is_none());
    for image in [
        DEFAULT_GATEWAY_IMAGE,
        SANDBOX_RUNTIME_IMAGE,
        SUPERVISOR_IMAGE,
    ] {
        assert!(
            engine.image(image).await.unwrap().is_some(),
            "missing pinned image: {image}"
        );
    }
    eprintln!(
        "owned rejected-create test gateway: {} ({})",
        spec.name, spec.gateway.endpoint
    );
    let client = start(&api, &engine, &spec).await;

    // OpenShell reserves the `_provider_` network policy prefix for the
    // policies it composes from providers, and validates a create request
    // before it stores anything.
    let name = "rejected-create";
    let mut policy = proto::SandboxPolicy::default();
    policy.network_policies.insert(
        "_provider_reserved".into(),
        proto::NetworkPolicyRule {
            name: "_provider_reserved".into(),
            ..Default::default()
        },
    );
    let status = client
        .raw_grpc()
        .create_sandbox(proto::CreateSandboxRequest {
            workspace_scope: Some(proto::workspace_selector("default")),
            name: name.into(),
            spec: Some(proto::SandboxSpec {
                policy: Some(policy),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .expect_err("OpenShell accepted a reserved policy key");
    assert_eq!(status.code(), tonic::Code::InvalidArgument, "{status}");

    // The provider treats this rejection as a create that left nothing behind.
    // If a later OpenShell stores the sandbox and then rejects it, this fails
    // and the clearing of the pending creation must be reconsidered.
    match client.get_sandbox(name).await {
        Err(SdkError::NotFound { .. }) => {}
        other => panic!("the rejected create left a sandbox behind: {other:?}"),
    }

    let container = engine.container(&spec.name).await.unwrap().unwrap();
    let labels = container.config.unwrap().labels.unwrap();
    assert_eq!(labels[OWNER_LABEL], spec.owner);
    assert_eq!(labels[GENERATION_LABEL], spec.generation);
    let id = container.id.unwrap();
    api.stop_container(&id, None).await.unwrap();
    api.remove_container(&id, None).await.unwrap();
    assert!(engine.container(&spec.name).await.unwrap().is_none());
    eprintln!("rejected sandbox create left no sandbox; gateway removed, gateway storage retained");
}
