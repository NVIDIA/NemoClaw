// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use nemoclaw_provider::openshell::{OpenShell, verify_identity};
use nemoclaw_sdk::{
    ObservationError, Secrets,
    backend::{Backend, Row},
    config::{Gateway, SearchProvider, search_provider_name},
};
use openshell_sdk::raw::proto;
use std::sync::Arc;

struct FixtureSecrets;
impl Secrets for FixtureSecrets {
    fn resolve(&self, reference: &str) -> Result<String, ObservationError> {
        assert_eq!(reference, "PROFILE_TEST_KEY");
        Ok("synthetic-profile-test-credential".into())
    }
}

async fn ensure(backend: &OpenShell, kind: &str, fields: &Row) -> Row {
    let result = backend.ensure(kind, fields).await;
    assert_eq!(result.error(), None, "{kind}: {}", fields["name"]);
    result.state().unwrap().clone()
}

async fn revision(client: &OpenShellClient, sandbox: &SandboxRef) -> u64 {
    let response = client
        .raw_grpc()
        .get_sandbox_provider_environment(proto::GetSandboxProviderEnvironmentRequest {
            sandbox_id: sandbox.id.clone(),
            supports_static_credential_bindings: true,
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(
        response.readiness_reason, 0,
        "provider environment is withheld"
    );
    assert_ne!(response.provider_env_revision, 0);
    response.provider_env_revision
}

#[tokio::test]
#[ignore = "requires a fresh owned gateway document and pinned local images; creates profiles, providers and a sandbox, retains workspace and gateway storage"]
async fn imported_profile_revisions_survive_repeated_reads_and_gateway_restart() {
    let spec = gateway_spec("NEMOCLAW_TEST_GATEWAY_DOCUMENT");
    let image = std::env::var("NEMOCLAW_TEST_GATEWAY_SANDBOX_IMAGE")
        .expect("explicit local sandbox image digest");
    assert!(image.contains("@sha256:"));
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
        &image,
    ] {
        assert!(
            engine.image(image).await.unwrap().is_some(),
            "missing pinned image: {image}"
        );
    }
    eprintln!(
        "owned profile test gateway: {} ({})",
        spec.name, spec.gateway.endpoint
    );
    let client = start(&api, &engine, &spec).await;
    let gateway: Gateway = serde_json::from_value(serde_json::json!({
        "management": "external", "endpoint": spec.gateway.endpoint
    }))
    .unwrap();
    let backend = OpenShell::connect(&gateway, Arc::new(FixtureSecrets)).unwrap();
    let mut base: Row = [
        ("name".into(), "profile-revision".into()),
        ("owner".into(), spec.owner.clone()),
        ("generation".into(), spec.generation.clone()),
    ]
    .into();
    let workspace = ensure(&backend, "workspace", &base).await;
    base.insert("workspace".into(), workspace["name"].clone());
    let mut profiles = Vec::new();
    let mut providers = Vec::new();
    for (name, kind, authenticated) in [
        ("openai", "", true),
        ("anthropic", "anthropic", true),
        ("local", "", false),
    ] {
        let mut fields = base.clone();
        fields.extend([
            ("name".into(), format!("nemoclaw-inference-{name}")),
            ("endpoint".into(), format!("https://{name}.example.com/v1")),
            ("provider_type".into(), kind.into()),
            ("authenticated".into(), authenticated.to_string()),
        ]);
        profiles.push(ensure(&backend, "provider_profile", &fields).await);
        fields.remove("authenticated");
        fields.insert("name".into(), name.into());
        fields.insert(
            "credential_env".into(),
            if authenticated {
                "PROFILE_TEST_KEY"
            } else {
                ""
            }
            .into(),
        );
        fields.insert("credential_source".into(), String::new());
        providers.push(ensure(&backend, "provider", &fields).await);
    }
    for search in [SearchProvider::Brave, SearchProvider::Tavily] {
        let mut fields = base.clone();
        fields.insert("name".into(), search.profile().into());
        profiles.push(ensure(&backend, "provider_profile", &fields).await);
        fields.extend([
            (
                "name".into(),
                search_provider_name(search, "PROFILE_TEST_KEY"),
            ),
            ("endpoint".into(), search.endpoint().into()),
            ("provider_type".into(), search.name().into()),
            ("credential_env".into(), "PROFILE_TEST_KEY".into()),
            ("credential_source".into(), String::new()),
        ]);
        providers.push(ensure(&backend, "provider", &fields).await);
    }
    let scoped = client.workspace(&workspace["name"]);
    let sandbox = scoped
        .create_sandbox(SandboxSpec {
            name: Some("profile-revision".into()),
            image: Some(image),
            labels: [
                (OWNER_LABEL.into(), spec.owner.clone()),
                (GENERATION_LABEL.into(), spec.generation.clone()),
            ]
            .into(),
            providers: providers.iter().map(|row| row["name"].clone()).collect(),
            command: vec!["/bin/sleep".into(), "600".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    scoped
        .wait_ready(&sandbox.name, Duration::from_secs(90))
        .await
        .unwrap();
    // This RPC is sandbox-only. Read this test sandbox's issued token from its
    // owned gateway, keep it in memory, and never log it or mint a replacement.
    let volume = engine.volume(&spec.volume()).await.unwrap().unwrap();
    let token = engine
        .read_file(
            &spec.name,
            &format!(
                "{}/state/openshell/docker-sandbox-tokens/{}/{}/sandbox.jwt",
                volume.mountpoint, spec.name, sandbox.id
            ),
            16 * 1024,
        )
        .await
        .unwrap();
    let token = String::from_utf8(token.expect("owned sandbox token exists"))
        .map_err(|_| "sandbox token is not UTF-8")
        .unwrap();
    let authentication = EdgeAuthInterceptor::new(Some(token.trim()), None).unwrap();
    if let Some(slot) = authentication.bearer_slot() {
        slot.write().unwrap().as_mut().unwrap().set_sensitive(true);
    }
    let sandbox_client = OpenShellClient::from_parts(
        Channel::from_shared(spec.gateway.endpoint.clone())
            .unwrap()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .connect_lazy(),
        authentication,
    );
    let expected_revision = revision(&sandbox_client, &sandbox).await;
    for _ in 0..64 {
        assert_eq!(revision(&sandbox_client, &sandbox).await, expected_revision);
    }
    for profile in &profiles {
        assert_eq!(
            ensure(&backend, "provider_profile", profile).await,
            *profile
        );
    }
    api.restart_container(&spec.name, None).await.unwrap();
    ready(&api, &spec, &client).await;
    scoped
        .wait_ready(&sandbox.name, Duration::from_secs(90))
        .await
        .unwrap();
    for _ in 0..64 {
        assert_eq!(revision(&sandbox_client, &sandbox).await, expected_revision);
    }
    let observed = scoped.get_sandbox(&sandbox.name).await.unwrap();
    assert_eq!(observed.id, sandbox.id);
    assert_eq!(observed.labels[OWNER_LABEL], spec.owner);
    assert_eq!(observed.labels[GENERATION_LABEL], spec.generation);
    assert_eq!(observed.phase, SandboxPhase::Ready);
    let deleted = scoped
        .delete_sandbox(&sandbox.name, DeleteOptions::default())
        .await
        .unwrap();
    assert_eq!(deleted.sandbox_id.as_deref(), Some(sandbox.id.as_str()));
    scoped
        .wait_deleted(&sandbox.name, Duration::from_secs(90), Some(&sandbox.id))
        .await
        .unwrap();
    for (kind, rows) in [("provider", providers), ("provider_profile", profiles)] {
        for prior in rows {
            let observed = backend.read(kind, &prior, true).await.unwrap().unwrap();
            verify_identity(&prior, &observed).unwrap();
            backend.remove(kind, &prior, true).await.unwrap();
            assert!(backend.read(kind, &prior, true).await.unwrap().is_none());
        }
    }
    assert_eq!(ensure(&backend, "workspace", &workspace).await, workspace);
    let container = engine.container(&spec.name).await.unwrap().unwrap();
    let labels = container.config.unwrap().labels.unwrap();
    assert_eq!(labels[OWNER_LABEL], spec.owner);
    assert_eq!(labels[GENERATION_LABEL], spec.generation);
    let id = container.id.unwrap();
    api.stop_container(&id, None).await.unwrap();
    api.remove_container(&id, None).await.unwrap();
    assert!(engine.container(&spec.name).await.unwrap().is_none());
    eprintln!(
        "stable profile revision before and after restart; owned workloads removed, workspace and gateway storage retained"
    );
}
