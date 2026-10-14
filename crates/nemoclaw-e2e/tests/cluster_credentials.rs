// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed credential routing through provider clients and packaged executables, without a cluster.

use nemoclaw_e2e::{openshell::Fixture, tofu::TofuWorkspace};
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
use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

const KEY: &str = "fixture-cluster-vllm-key";

// Keep production identity validation; return a fixed key instead of resolving
// it, and a fixed Service address. The fixture's `exec_calls` counts OpenShell
// ExecSandbox RPCs, not Kubernetes Pod exec.
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

/// A compiled row whose `gateway` ref names the fixture, which takes no credentials.
fn at_fixture(row: &Row, endpoint: &str) -> Row {
    let mut row = row.clone();
    for (attribute, field) in nemoclaw_openshell::GATEWAY_FIELDS {
        let value = if attribute == "endpoint" {
            endpoint
        } else {
            ""
        };
        row.insert(field.into(), value.into());
    }
    row
}

/// OpenTofu attributes for a row, with each `ref` input as a literal object in
/// place of the row fields it carries, or null when the row names nothing.
fn typed_attributes(kind: &str, row: &Row) -> Value {
    let mut attributes = serde_json::to_value(row).unwrap();
    let object = attributes.as_object_mut().unwrap();
    for reference in nemoclaw_openshell::references(kind) {
        assert!(!reference.list, "{kind}: these tests write no list refs");
        let mut value = json!({"type": reference.kind});
        for (attribute, field) in &reference.fields {
            value[*attribute] = object.remove(*field).unwrap_or_else(|| json!(""));
        }
        let named = reference
            .fields
            .iter()
            .any(|(attribute, _)| value[*attribute] != "");
        object.insert(
            reference.attribute.into(),
            if named { value } else { Value::Null },
        );
    }
    attributes
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
    let config = GatewayConfig::default();
    let mut diagnostics = tf_provider::Diagnostics::default();
    assert_eq!(client.configure(&mut diagnostics, &config), Some(false));
    assert!(diagnostics.errors.is_empty());
    let backend = OpenShellBackend(client.clone());
    let mut saved = None;
    for kind in ["workspace", "provider_profile", "provider"] {
        let target = targets.iter().find(|t| t.kind == kind).unwrap();
        let mut values = at_fixture(&target.values, &fixture.endpoint);
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
        .read("provider", &at_fixture(&saved, &fixture.endpoint), false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed, saved);
    assert!(services.validations.load(Ordering::SeqCst) > validations);
    assert_eq!(services.resolutions.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; local gateway fixture only"]
async fn bundled_fabric_configuration_refresh_uses_managed_cluster_callbacks() {
    let bundle = nemoclaw_test_fixtures::Bundle::from_env();
    let version = nemoclaw_sdk::bundle::Bundle::open(bundle.root())
        .unwrap()
        .manifest
        .version;
    let fixture = Fixture::start().await;
    // Select the verified packaged executable so a generic Fabric binary cannot
    // replace NemoClaw's managed-service integration in the release bundle.
    let directory =
        TofuWorkspace::with_providers(bundle.tofu(), &[("fabric", &bundle.provider("fabric"))]);
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
    let backend = OpenShellBackend(client);
    let mut sandbox = None;
    for kind in ["workspace", "provider_profile", "provider", "sandbox"] {
        let target = targets.iter().find(|target| target.kind == kind).unwrap();
        let created = backend
            .ensure(kind, &at_fixture(&target.values, &fixture.endpoint))
            .await;
        assert!(created.error().is_none(), "{kind}: {:?}", created.error());
        if kind == "sandbox" {
            sandbox = created.into_parts().0;
        }
    }
    let sandbox = sandbox.unwrap();
    assert_eq!(
        backend
            .read("sandbox", &at_fixture(&sandbox, &fixture.endpoint), false)
            .await
            .unwrap(),
        Some(sandbox.clone()),
        "the saved sandbox and its managed profile grants must be valid"
    );
    let target = targets
        .iter()
        .find(|target| target.kind == "agent_configuration")
        .unwrap();
    let mut fields = at_fixture(&target.values, &fixture.endpoint);
    fields.insert("sandbox_id".into(), sandbox["id"].clone());
    let config = typed_attributes(&target.kind, &fields);

    let (kind, name) = target.address.split_once('.').unwrap();
    fs::write(
        directory.path().join("main.tf.json"),
        json!({
            "terraform": {"required_providers": {"fabric": {
                "source": compile::FABRIC_PROVIDER_ADDRESS,
                "version": format!("= {version}"),
            }}},
            "provider": {"fabric": {}},
            "resource": {kind: {name: config}},
        })
        .to_string(),
    )
    .unwrap();
    let mut attributes = config.clone();
    attributes["id"] = json!(sandbox["id"]);
    attributes["running"] = json!("true");
    let state_path = directory.path().join("terraform.tfstate");
    let original = serde_json::to_vec(&json!({
        "version": 4, "terraform_version": compile::OPENTOFU_VERSION,
        "serial": 1, "lineage": "f8b49b48-a168-4ca8-abf7-c9526d2c742a", "outputs": {},
        "resources": [{
            "mode": "managed", "type": kind, "name": name,
            "provider": format!("provider[\"{}\"]", compile::FABRIC_PROVIDER_ADDRESS),
            "instances": [{"schema_version": 1, "attributes": attributes}],
        }],
    }))
    .unwrap();
    fs::write(&state_path, &original).unwrap();
    // Creating the provider registration above resolved the key in process.
    // The bundled provider below runs out of process with its own services,
    // so this counter cannot observe it.
    assert_eq!(services.resolutions.load(Ordering::SeqCst), 1);
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

    let output = directory
        .command()
        .args(["plan", "-input=false", "-no-color"])
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; local gateway fixture only"]
async fn bundled_openshell_provider_refreshes_saved_cluster_credentials_without_resolving_them() {
    use openshell_core::proto;

    let bundle = nemoclaw_test_fixtures::Bundle::from_env();
    let version = nemoclaw_sdk::bundle::Bundle::open(bundle.root())
        .unwrap()
        .manifest
        .version;
    let fixture = Fixture::start().await;
    // Select the verified packaged executable, not a target/debug sibling that
    // could lack NemoClaw's cluster callbacks.
    let directory = TofuWorkspace::with_providers(
        bundle.tofu(),
        &[("openshell", &bundle.provider("openshell"))],
    );
    let mut input: Value =
        serde_saphyr::from_str(include_str!("../../../examples/kubernetes/local-vllm.yaml"))
            .unwrap();
    input["spec"]["gateway"]["kubernetes"]["kubeconfig"] =
        json!({"env": "FIXTURE_CLUSTER_KUBECONFIG"});
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
    let target = compile::targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == "provider")
        .unwrap();
    let mut fields = at_fixture(&target.values, &fixture.endpoint);
    fields.insert("profile_name".into(), String::new());
    let source = &fields["credential_source"];
    assert!(matches!(
        nemoclaw_sdk::services::authentication::Source::parse(
            source,
            &fields["owner"],
            &fields["endpoint"],
        )
        .unwrap(),
        nemoclaw_sdk::services::authentication::Source::ClusterService { .. }
    ));
    let registration = proto::Provider {
        metadata: Some(proto::ObjectMeta {
            id: "saved-cluster-registration".into(),
            name: fields["name"].clone(),
            workspace: fields["workspace"].clone(),
            labels: [
                (
                    nemoclaw_provider::openshell::OWNER.into(),
                    fields["owner"].clone(),
                ),
                (
                    nemoclaw_provider::openshell::GENERATION.into(),
                    fields["generation"].clone(),
                ),
            ]
            .into(),
            annotations: nemoclaw_sdk::config::credential_metadata::pack(source).unwrap(),
            resource_version: 1,
            ..Default::default()
        }),
        r#type: format!("nemoclaw-inference-{}", fields["name"]),
        profile_workspace: fields["workspace"].clone(),
        config: [("OPENAI_BASE_URL".into(), fields["endpoint"].clone())].into(),
        ..Default::default()
    };
    let key = format!("{}/{}", fields["workspace"], fields["name"]);
    fixture
        .state
        .lock()
        .unwrap()
        .providers
        .insert(key.clone(), registration.clone());

    let (kind, name) = target.address.split_once('.').unwrap();
    fs::write(
        directory.path().join("main.tf.json"),
        json!({
            "terraform": {"required_providers": {"openshell": {
                "source": compile::OPENSHELL_PROVIDER_ADDRESS,
                "version": format!("= {version}"),
            }}},
            "provider": {"openshell": {}},
            "resource": {kind: {name: typed_attributes(&target.kind, &fields)}},
        })
        .to_string(),
    )
    .unwrap();
    let mut saved = fields.clone();
    saved.insert("id".into(), "saved-cluster-registration".into());
    let mut attributes = typed_attributes(&target.kind, &saved);
    let export = nemoclaw_openshell::export(&target.kind).unwrap();
    let mut reference = json!({"type": export.kind});
    for field in export.fields {
        reference[field] = json!(saved[field]);
    }
    attributes["ref"] = reference;
    let state_path = directory.path().join("terraform.tfstate");
    let original = serde_json::to_vec(&json!({
        "version": 4, "terraform_version": compile::OPENTOFU_VERSION,
        "serial": 1, "lineage": "cd73e09f-c75c-48ce-86af-352a4764560e", "outputs": {},
        "resources": [{
            "mode": "managed", "type": kind, "name": name,
            "provider": format!("provider[\"{}\"]", compile::OPENSHELL_PROVIDER_ADDRESS),
            "instances": [{"schema_version": 1, "attributes": attributes}],
        }],
    }))
    .unwrap();
    fs::write(&state_path, &original).unwrap();
    let run = |arguments: &[&str]| {
        let output = directory
            .command()
            .args(arguments)
            .env(
                "FIXTURE_CLUSTER_KUBECONFIG",
                directory.path().join("absent.kubeconfig"),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "OpenTofu {arguments:?} exited with {}\n{}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        output
    };
    run(&[
        "plan",
        "-detailed-exitcode",
        "-input=false",
        "-no-color",
        "-out=refresh.plan",
    ]);
    let plan: Value =
        serde_json::from_slice(&run(&["show", "-json", "refresh.plan"]).stdout).unwrap();
    let resources = plan["planned_values"]["root_module"]["resources"]
        .as_array()
        .unwrap();
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0]["address"], target.address);
    assert_eq!(resources[0]["values"]["id"], "saved-cluster-registration");
    assert_eq!(resources[0]["values"]["credential_source"], source.as_str());
    assert_eq!(fs::read(state_path).unwrap(), original);
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.effects, 0);
    assert_eq!(state.providers[&key], registration);
}
