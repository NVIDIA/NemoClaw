// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed credential routing through provider clients and packaged executables, without a cluster.

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_provider::{
    cluster_services::OpenShellServices,
    openshell::{GatewayClient, GatewayConfig, OpenShellBackend, Services},
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
    let config = GatewayConfig {
        endpoint: tf_provider::value::Value::Value(fixture.endpoint.clone()),
        ..Default::default()
    };
    let mut diagnostics = tf_provider::Diagnostics::default();
    assert_eq!(client.configure(&mut diagnostics, &config), Some(false));
    assert!(diagnostics.errors.is_empty());
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
        assert_eq!(
            registered.config,
            [("OPENAI_BASE_URL".into(), registration["endpoint"].clone())].into()
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
    assert_eq!(client.configure(&mut diagnostics, &config), Some(false));
    assert!(diagnostics.errors.is_empty());
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; local gateway fixture only"]
async fn bundled_fabric_configuration_refresh_uses_managed_cluster_callbacks() {
    use nemoclaw_sdk::bundle::Bundle;
    use std::{fs, path::PathBuf, process::Command};

    let bundle = Bundle::open(&PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("explicit verified native bundle"),
    ))
    .unwrap();
    let fixture = Fixture::start().await;
    let directory = tempfile::tempdir().unwrap();
    let missing_kubeconfig = format!(
        "NEMOCLAW_TEST_FABRIC_MISSING_KUBECONFIG_{}",
        std::process::id()
    );
    let mut input: Value =
        serde_saphyr::from_str(include_str!("../../../examples/kubernetes/local-vllm.yaml"))
            .unwrap();
    input["spec"]["gateway"]["kubernetes"]["kubeconfig"] = json!({"env": missing_kubeconfig});
    input["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
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
    let targets = nemoclaw_e2e::image_runtime::targets(&document, &generations).unwrap();
    let services = Arc::new(ClusterReads::default());
    let client = Arc::new(GatewayClient::with_services(services.clone()));
    client
        .connect(&nemoclaw_openshell::Connection {
            endpoint: fixture.endpoint.clone(),
            ..Default::default()
        })
        .unwrap();
    let backend = OpenShellBackend(client);
    let mut sandbox = None;
    for kind in ["workspace", "provider_profile", "provider", "sandbox"] {
        let target = targets.iter().find(|target| target.kind == kind).unwrap();
        let created = backend.ensure(kind, &target.values).await;
        assert!(created.error().is_none(), "{kind}: {:?}", created.error());
        if kind == "sandbox" {
            sandbox = created.into_parts().0;
        }
    }
    let sandbox = sandbox.unwrap();
    assert_eq!(
        backend.read("sandbox", &sandbox, false).await.unwrap(),
        Some(sandbox.clone()),
        "the saved sandbox and its managed profile grants must be valid"
    );
    let target = targets
        .iter()
        .find(|target| target.kind == "agent_configuration")
        .unwrap();
    let mut fields = target.values.clone();
    fields.insert("sandbox_id".into(), sandbox["id"].clone());

    // Read the packaged executable so a generic Fabric binary cannot silently
    // replace NemoClaw's managed-service integration in the release bundle.
    let provider_directory = bundle.directory.join(format!(
        "providers/{}/{}/{}",
        compile::FABRIC_PROVIDER_ADDRESS,
        bundle.manifest.version,
        nemoclaw_sdk::bundle::platform().unwrap(),
    ));
    let cli_config = directory.path().join("tofu.rc");
    fs::write(
        &cli_config,
        format!(
            "provider_installation {{ dev_overrides {{ \"{}\" = {} }} }}",
            compile::FABRIC_PROVIDER_ADDRESS,
            serde_json::to_string(&provider_directory).unwrap(),
        ),
    )
    .unwrap();
    let (kind, name) = target.address.split_once('.').unwrap();
    fs::write(
        directory.path().join("main.tf.json"),
        json!({
            "terraform": {"required_providers": {"fabric": {
                "source": compile::FABRIC_PROVIDER_ADDRESS,
                "version": format!("= {}", bundle.manifest.version),
            }}},
            "provider": {"fabric": {"endpoint": fixture.endpoint}},
            "resource": {kind: {name: fields}},
        })
        .to_string(),
    )
    .unwrap();
    let mut attributes = serde_json::to_value(&fields).unwrap();
    attributes["id"] = json!(sandbox["id"]);
    attributes["running"] = json!("true");
    let state_path = directory.path().join("terraform.tfstate");
    let original = serde_json::to_vec(&json!({
        "version": 4, "terraform_version": compile::OPENTOFU_VERSION,
        "serial": 1, "lineage": "f8b49b48-a168-4ca8-abf7-c9526d2c742a", "outputs": {},
        "resources": [{
            "mode": "managed", "type": kind, "name": name,
            "provider": format!("provider[\"{}\"]", compile::FABRIC_PROVIDER_ADDRESS),
            "instances": [{"schema_version": 0, "attributes": attributes}],
        }],
    }))
    .unwrap();
    fs::write(&state_path, &original).unwrap();
    let before = {
        let state = fixture.state.lock().unwrap();
        assert!(state.exec_calls.is_empty());
        (
            state.effects,
            state.workspaces.clone(),
            state.profiles.clone(),
            state.providers.clone(),
            state.sandboxes.clone(),
        )
    };

    let output = Command::new(bundle.tofu())
        .current_dir(directory.path())
        .args(["plan", "-input=false", "-no-color"])
        .env("TF_CLI_CONFIG_FILE", &cli_config)
        .env("TF_IN_AUTOMATION", "1")
        .env("CHECKPOINT_DISABLE", "1")
        .env_remove(&missing_kubeconfig)
        .output()
        .unwrap();
    let diagnostic = format!(
        "OpenTofu exited with {}\n{}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    // The SDK callback accepts the owned cluster source, then fails at the
    // deliberately absent kubeconfig. Docker-only callbacks reject its identity.
    assert!(!output.status.success(), "{diagnostic}");
    assert!(
        diagnostic.contains(&ObservationError::Authentication.to_string()),
        "{diagnostic}"
    );
    assert!(
        !diagnostic.contains(&ObservationError::BindingMismatch.to_string()),
        "{diagnostic}"
    );
    assert_eq!(fs::read(state_path).unwrap(), original);
    assert_eq!(services.resolutions.load(Ordering::SeqCst), 1);
    let state = fixture.state.lock().unwrap();
    assert!(state.exec_calls.is_empty());
    assert_eq!(
        (
            state.effects,
            state.workspaces.clone(),
            state.profiles.clone(),
            state.providers.clone(),
            state.sandboxes.clone(),
        ),
        before,
    );
}
