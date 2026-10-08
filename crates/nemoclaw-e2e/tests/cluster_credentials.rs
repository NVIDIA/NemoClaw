// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed credential routing through the provider's gateway client, without a bundle or cluster.

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_provider::{
    cluster_services::OpenShellServices,
    openshell::{GatewayClient, OpenShellBackend, Services},
};
use nemoclaw_sdk::{
    ObservationError,
    backend::{Backend, Row},
    compile,
    config::Document,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const KEY: &str = "fixture-cluster-vllm-key";

// Keep production identity validation; replace only cluster reads and Pod exec.
#[derive(Default)]
struct ClusterReads {
    validations: AtomicUsize,
    resolutions: AtomicUsize,
}

#[async_trait::async_trait]
impl Services for ClusterReads {
    fn validate_credential_source(
        &self,
        source: &str,
        owner: &str,
        endpoint: &str,
    ) -> Result<(), ObservationError> {
        OpenShellServices.validate_credential_source(source, owner, endpoint)?;
        self.validations.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn resolve_credential_source(
        &self,
        source: &str,
        owner: &str,
        endpoint: &str,
    ) -> Result<String, ObservationError> {
        OpenShellServices.validate_credential_source(source, owner, endpoint)?;
        self.resolutions.fetch_add(1, Ordering::SeqCst);
        Ok(KEY.into())
    }

    fn validate_cluster_source(&self, row: &Row) -> Result<(), ObservationError> {
        OpenShellServices.validate_cluster_source(row)
    }

    async fn cluster_addresses(
        &self,
        row: &Row,
    ) -> Result<Vec<std::net::IpAddr>, ObservationError> {
        self.validate_cluster_source(row)?;
        Ok(vec!["10.96.0.23".parse().unwrap()])
    }
}

#[tokio::test]
async fn configured_gateway_routes_cluster_keys_to_registration_and_refreshes_only_the_reference() {
    let fixture = Fixture::start().await;
    let mut document: Value =
        serde_saphyr::from_str(include_str!("../../../examples/kubernetes/local-vllm.yaml"))
            .unwrap();
    document["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
    let document = Document::parse(document.to_string().as_bytes()).unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_storage",
        "kubernetes_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let targets = compile::targets(&document, &generations).unwrap();
    let registration = &targets
        .iter()
        .find(|t| t.kind == "provider")
        .unwrap()
        .values;
    let services = Arc::new(ClusterReads::default());
    let client = Arc::new(GatewayClient::with_services(services.clone()));
    let connection = nemoclaw_openshell::Connection {
        endpoint: fixture.endpoint.clone(),
        ..Default::default()
    };
    client.connect(&connection).unwrap();
    let backend = OpenShellBackend(client.clone());
    let mut saved = None;
    for kind in ["workspace", "provider_profile", "provider"] {
        let target = targets.iter().find(|t| t.kind == kind).unwrap();
        let mut values = target.values.clone();
        // The image data source normally supplies the profile's binary paths.
        if kind == "provider_profile" {
            values.insert("binaries_json".into(), r#"["/usr/bin/python3"]"#.into());
        }
        backend.plan(kind, &values, None).await.unwrap();
        let created = backend.ensure(kind, &values).await;
        assert!(created.error().is_none(), "{kind}: {:?}", created.error());
        if kind == "provider" {
            saved = created.into_parts().0;
        }
    }
    let saved = saved.unwrap();
    assert_eq!(
        saved["credential_source"],
        registration["credential_source"]
    );
    assert!(!serde_json::to_string(&saved).unwrap().contains(KEY));
    assert_eq!(services.resolutions.load(Ordering::SeqCst), 1);
    let key = format!("{}/{}", registration["workspace"], registration["name"]);
    let effects = {
        let state = fixture.state.lock().unwrap();
        let registered = &state.providers[&key];
        let profile =
            &state.profiles[&format!("{}/{}", registration["workspace"], registered.r#type)];
        assert_eq!(profile.credentials.len(), 1);
        assert_eq!(
            registered.credentials,
            [(profile.credentials[0].name.clone(), KEY.into())].into()
        );
        let metadata = registered.metadata.as_ref().unwrap();
        assert!(
            !serde_json::to_string(&metadata.annotations)
                .unwrap()
                .contains(KEY)
        );
        assert!(
            !serde_json::to_string(&metadata.labels)
                .unwrap()
                .contains(KEY)
        );
        state.effects
    };

    // Provider reconfiguration must retain the selected service callbacks.
    client.reset(false).unwrap();
    client.connect(&connection).unwrap();
    let validations = services.validations.load(Ordering::SeqCst);
    let observed = backend
        .read("provider", &saved, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed, saved);
    assert!(services.validations.load(Ordering::SeqCst) > validations);
    assert_eq!(services.resolutions.load(Ordering::SeqCst), 1);
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.effects, effects);
    assert!(state.exec_calls.is_empty());
}
