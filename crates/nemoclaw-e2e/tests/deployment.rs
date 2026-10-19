// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_e2e::{assert_same_managed_resources, openshell::Fixture};
use nemoclaw_sdk::{CancellationToken, Deployment, Outcome, config::Document};
use std::{collections::BTreeMap, fs, path::PathBuf, process::Command};

/// Export refuses a deployment whose apply is unfinished before it observes
/// anything, so this checks the saved state without reading the SDK's files.
async fn assert_apply_unfinished(deployment: &Deployment, cancel: &CancellationToken) {
    let error = deployment.export(cancel).await.unwrap_err().to_string();
    assert!(error.contains("apply is unfinished"), "{error}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn cli_terminal_outputs_preserve_lifecycle_and_json_contract() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let input = directory.path().join("deployment.yaml");
    let state = directory.path().join("state");
    fs::write(&input, document.yaml().unwrap()).unwrap();
    let invoke = |operation: &str, format: &str| {
        let mut command = Command::new(
            bundle
                .join("bin")
                .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
        );
        command
            .args([
                operation,
                "-o",
                format,
                "--progress",
                "plain",
                "--state-dir",
            ])
            .arg(&state);
        if operation != "destroy" {
            command.arg(&input).arg("--non-interactive");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{operation}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!output.stdout.contains(&0x1b));
        assert!(!output.stderr.contains(&0x1b));
        output
    };
    let planned = invoke("plan", "text");
    let preview = String::from_utf8(planned.stdout).unwrap();
    assert!(preview.contains("sandbox/assistant"), "{preview}");
    assert!(preview.contains("No runtime resources changed"));
    assert_eq!(fixture.state.lock().unwrap().effects, 0);

    let applied = invoke("apply", "json");
    let result: serde_json::Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(result["outcome"], "succeeded");
    assert!(!result["changes"].as_array().unwrap().is_empty());
    let effects = fixture.state.lock().unwrap().effects;
    let planned = invoke("plan", "json");
    let result: serde_json::Value = serde_json::from_slice(&planned.stdout).unwrap();
    assert_eq!(result["complete"], true);
    assert!(result.get("deferred").is_none());
    // Plans read no inference catalogs; OpenShell carries inference traffic.
    assert!(result.get("unverified").is_none());
    let planned = invoke("plan", "text");
    let preview = String::from_utf8(planned.stdout).unwrap();
    assert!(preview.contains("No resource changes planned."));
    assert!(!preview.contains("Unverified checks:"));
    assert!(
        !result["discovery"]["targets"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    assert_eq!(result["changes"], serde_json::json!([]));
    let applied = invoke("apply", "text");
    let summary = String::from_utf8(applied.stdout).unwrap();
    assert!(summary.contains("Apply complete"), "{summary}");
    assert!(summary.contains("No resource changes"));
    assert!(summary.contains("Model and agent responses were not tested"));
    assert_eq!(fixture.state.lock().unwrap().effects, effects);

    let destroyed = invoke("destroy", "text");
    let summary = String::from_utf8(destroyed.stdout).unwrap();
    assert!(summary.contains("Destroy complete"), "{summary}");
    assert!(summary.contains("Sandbox files and conversation history deleted"));
    let repeated = invoke("destroy", "json");
    let result: serde_json::Value = serde_json::from_slice(&repeated.stdout).unwrap();
    assert_eq!(result["outcome"], "destroyed");
    assert_eq!(result["changes"], serde_json::json!([]));
    let observed = fixture.state.lock().unwrap();
    assert!(observed.sandboxes.is_empty());
    assert!(observed.providers.is_empty());
    assert!(observed.workspaces.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn missing_selected_provider_reconciles_without_sandbox_changes() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    let initial = deployment.apply(&document, &cancel).await.unwrap();
    let sandbox = fixture.state.lock().unwrap().sandboxes.clone();
    let profile = fixture.state.lock().unwrap().profiles.clone();
    fixture.state.lock().unwrap().providers.clear();
    let recreated = deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(recreated.changes.len(), 1);
    assert_eq!(
        recreated.changes[0].resource,
        initial
            .changes
            .iter()
            .find(|change| change.resource.starts_with("openshell_inference."))
            .unwrap()
            .resource
    );
    // The profile survived without its registration, so the inference
    // resource is replaced: removal deletes the profile and creation
    // recreates both, identically because the graph sets the generation.
    // The sandbox is unaffected.
    assert_eq!(recreated.changes[0].actions, ["delete", "create"]);
    assert_eq!(fixture.state.lock().unwrap().sandboxes, sandbox);
    assert_eq!(fixture.state.lock().unwrap().profiles, profile);
    assert_eq!(fixture.state.lock().unwrap().providers.len(), 1);
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    deployment.destroy(&cancel).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn independent_sandboxes_reconcile_concurrently_and_retain_shared_dependencies() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let mut second = document.spec.sandboxes[0].clone();
    second.name = "independent".into();
    document.spec.sandboxes.push(second);
    fixture.state.lock().unwrap().sandbox_create_delay = std::time::Duration::from_secs(2);
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(
            state.peak_sandbox_creates, 2,
            "independent creates must overlap"
        );
        assert_eq!(state.active_sandbox_creates, 0);
        assert_eq!(state.sandboxes.len(), 2);
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.providers.len(), 1);
    }
    let effects = fixture.state.lock().unwrap().effects;
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    deployment.destroy(&cancel).await.unwrap();
    let state = fixture.state.lock().unwrap();
    assert!(state.sandboxes.is_empty());
    assert!(state.providers.is_empty());
    assert!(state.workspaces.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn incompatible_gateway_is_reported_by_opentofu_plan_without_sdk_preflight() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    fixture.state.lock().unwrap().driver = Some("podman".into());
    let error = Deployment::new(directory.path(), &bundle)
        .plan(&document, &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(
        matches!(&error, nemoclaw_sdk::Error::Execution { operation, .. } if operation == "plan"),
        "{error}"
    );
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn gateway_change_between_plan_and_apply_preserves_resources_and_allows_teardown() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let cancel = CancellationToken::new();
    let deployment = Deployment::new(directory.path(), &bundle);
    deployment.apply(&document, &cancel).await.unwrap();
    let prior = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    let state = fixture.state.clone();
    let guarded = Deployment::new(directory.path(), &bundle).with_progress(std::sync::Arc::new(
        move |event| {
            if event == nemoclaw_sdk::Progress::Applying {
                state.lock().unwrap().driver = Some("podman".into());
            }
        },
    ));
    let error = guarded.apply(&document, &cancel).await.unwrap_err();
    assert!(
        matches!(&error, nemoclaw_sdk::Error::Execution { operation, .. } if operation == "apply"),
        "{error}"
    );
    assert!(
        error.to_string().contains(
            "gateway compute driver is podman, but spec.gateway.runtime.provider is docker"
        ),
        "{error}"
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_same_managed_resources(
        &fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        &prior,
    );
    // This apply planned no managed-resource mutations, so a failed read
    // must not impose the original-intent guard for ambiguous OpenShell writes.
    fixture.state.lock().unwrap().driver = None;
    let failed_state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        failed_state,
        "export verifies established bindings without completing another apply"
    );
    document.metadata.name = "corrected-observation-intent".into();
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    fixture.state.lock().unwrap().driver = Some("podman".into());
    deployment.destroy(&cancel).await.unwrap();
    assert!(fixture.state.lock().unwrap().workspaces.is_empty());
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn interrupted_create_preserves_pending_targets_allows_unrelated_intent_and_recovers() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    fixture.state.lock().unwrap().lose_create = true;
    assert!(deployment.apply(&document, &cancel).await.is_err());
    let effects = fixture.state.lock().unwrap().effects;
    assert!(deployment.plan_destroy(&cancel).await.is_err());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_apply_unfinished(&deployment, &cancel).await;
    // The lost reply was the inference registration's: its target cannot change.
    let mut changed = document.clone();
    changed.spec.inference_providers[0].endpoint = "http://172.20.0.1:11437/v1".into();
    let error = deployment.apply(&changed, &cancel).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("unfinished creation requires its original resource configuration"),
        "{error}"
    );
    document.metadata.name = "revised-unrelated-description".into();
    deployment.apply(&document, &cancel).await.unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    assert_eq!(effects, 4);
    let preview = deployment.plan_destroy(&cancel).await.unwrap();
    // Destroy also removes the agent configuration that replaces the sandbox,
    // the workspace, and the record of the sandbox image's pull.
    assert_eq!(preview.changes.len(), 6);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    let destroyed = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["destroy", "--state-dir"])
    .arg(directory.path())
    .output()
    .unwrap();
    assert!(
        destroyed.status.success(),
        "{}",
        String::from_utf8_lossy(&destroyed.stderr)
    );

    assert!(
        deployment
            .destroy(&cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert!(fixture.state.lock().unwrap().workspaces.is_empty());
    // The workspace, registration, sandbox, agent, the agent's
    // configuration, and the sandbox image's pull: re-apply after destroy
    // recreates the workspace too.
    assert_eq!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .len(),
        6
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn sdk_apply_cli_export_sdk_reapply_and_cli_destroy_share_state() {
    let lifecycle = Lifecycle::start(include_str!(
        "../../nemoclaw-sdk/tests/fixtures/config/local.yaml"
    ))
    .await;
    let effects = lifecycle.apply().await;
    assert_eq!(effects, lifecycle.document.spec.sandboxes.len() + 3);
    lifecycle.export_and_reapply_unchanged(effects).await;
    lifecycle.destroy();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn separate_agent_sandboxes_cli_export_reapply_and_policy_drift() {
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    let primary = document.spec.sandboxes[0].clone();
    for name in ["reader", "reviewer", "auditor"] {
        let mut sandbox = primary.clone();
        sandbox.name = name.into();
        sandbox.agent.name = name.into();
        sandbox.agent.tools = Some(nemoclaw_sdk::config::AgentTools {
            allow: vec!["read".into()],
        });
        document.spec.sandboxes.push(sandbox);
    }
    let lifecycle = Lifecycle::start(&document.yaml().unwrap()).await;
    let effects = lifecycle.apply().await;
    assert_eq!(effects, lifecycle.document.spec.sandboxes.len() + 3);
    lifecycle.export_and_reapply_unchanged(effects).await;
    lifecycle.assert_tool_policy_drift(effects).await;
    lifecycle.destroy();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn tool_disclosure_cli_export_reapply_and_configuration_on_stdin() {
    // Disclosure modes are opaque native settings; agent_tools in the SDK owns
    // both modes, so one deployment covers their drift detection.
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    document.spec.sandboxes[0]
        .harness
        .as_mut()
        .unwrap()
        .settings = Some(
        serde_json::from_value(serde_json::json!({"native_config":{"tools":{"toolSearch":
            {"mode":"tools","searchDefaultLimit":8,"maxSearchLimit":20}}}}))
        .unwrap(),
    );
    // Export and reapply also cover an authored inference API.
    document.spec.inference_providers[0].api =
        Some(nemoclaw_sdk::config::InferenceApi::OpenaiCompletions);
    let lifecycle = Lifecycle::start(&document.yaml().unwrap()).await;
    let effects = lifecycle.apply().await;
    assert_eq!(effects, lifecycle.document.spec.sandboxes.len() + 3);
    lifecycle.export_and_reapply_unchanged(effects).await;
    lifecycle.assert_configuration_on_stdin().await;
    lifecycle.destroy();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn web_search_cli_export_reapply_and_registration_drift() {
    // Every definition scope and provider compiles to the same kind of targets
    // (web_search in the SDK), and their registration drift is one code path.
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    document.spec.integrations = serde_json::from_value(serde_json::json!({
        "search":{"kind":"webSearch","provider":"tavily","credential":{"env":"SEARCH_KEY"}}
    }))
    .unwrap();
    document.spec.sandboxes[0].agent.integration_refs = vec!["search".into()];
    let lifecycle = Lifecycle::start(&document.yaml().unwrap()).await;
    let effects = lifecycle.apply().await;
    assert_eq!(effects, lifecycle.document.spec.sandboxes.len() + 5);
    lifecycle.export_and_reapply_unchanged(effects).await;
    lifecycle.assert_search_registration_drift().await;
    lifecycle.destroy();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn api_integration_applies_exports_and_reapplies_unchanged() {
    // A key-authenticated API registers one OpenShell provider the sandbox
    // attaches, like web search, and survives export and re-apply.
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    document.spec.integrations = serde_json::from_value(serde_json::json!({
        "bookings":{"kind":"api","endpoint":"https://bookings.example.com/mcp",
            "credential":{"env":"BOOKINGS_API_KEY"}}
    }))
    .unwrap();
    document.spec.sandboxes[0].agent.integration_refs = vec!["bookings".into()];
    let lifecycle = Lifecycle::start(&document.yaml().unwrap()).await;
    let effects = lifecycle.apply().await;
    assert_eq!(effects, lifecycle.document.spec.sandboxes.len() + 5);
    lifecycle.export_and_reapply_unchanged(effects).await;
    lifecycle.destroy();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn network_grants_apply_export_and_reapply_unchanged() {
    // Grants added to the isolated preset reach the sandbox's managed policy
    // and survive export and re-apply.
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    document.spec.sandboxes[0].network = serde_json::from_value(serde_json::json!({
        "tier": "isolated",
        "grants": {"docs": {"endpoints": [{
            "host": "docs.example.com", "port": 443, "protocol": "rest", "enforcement": "enforce",
            "rules": [{"allow": {"method": "GET", "path": "/**"}}]
        }]}}
    }))
    .unwrap();
    let lifecycle = Lifecycle::start(&document.yaml().unwrap()).await;
    let effects = lifecycle.apply().await;
    lifecycle.export_and_reapply_unchanged(effects).await;
    lifecycle.destroy();
}

/// Progress events that the deployment's callback records.
type Recorded<T> = std::sync::Arc<std::sync::Mutex<Vec<T>>>;

/// A deployment through the SDK and the bundle's CLI against the fixture gateway.
/// Fields drop in declaration order: the deployment before the image engine or
/// metadata bundle, gateway, and state directory.
pub(crate) struct Lifecycle {
    pub(crate) cancel: CancellationToken,
    pub(crate) deployment: Deployment,
    resource_events: Recorded<(&'static str, &'static str, &'static str)>,
    timings: Recorded<(&'static str, nemoclaw_sdk::StepOutcome)>,
    _image_engine: Option<nemoclaw_e2e::http_fixture::Fixture>,
    _image_metadata: Option<tempfile::TempDir>,
    pub(crate) document: Document,
    pub(crate) fixture: Fixture,
    pub(crate) directory: tempfile::TempDir,
    pub(crate) bundle: PathBuf,
}

/// Fixture values for the credentials the tests reference, and the image
/// metadata bundle's path for each variable that names it.
struct FixtureSecrets {
    image_metadata: BTreeMap<String, String>,
}
impl nemoclaw_sdk::Secrets for FixtureSecrets {
    fn resolve(&self, name: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
        if let Some(path) = self.image_metadata.get(name) {
            return Ok(path.clone());
        }
        assert!(["NOUS_API_KEY", "SEARCH_KEY", "BOOKINGS_API_KEY"].contains(&name));
        Ok("fixture-only-inference-key".into())
    }
}

impl Lifecycle {
    /// Start the fixture gateway and image engine, and create a deployment of `input`.
    pub(crate) async fn start(input: &str) -> Self {
        let fixture = Fixture::start().await;
        let mut document = Document::parse(input.as_bytes()).unwrap();
        *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
        let image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
        let secrets = FixtureSecrets {
            image_metadata: BTreeMap::new(),
        };
        Self {
            _image_engine: Some(image_engine),
            ..Self::new(document, fixture, secrets)
        }
    }

    /// Start the fixture gateway as the external Kubernetes or OpenShift
    /// gateway of `input`, and create a deployment of `input` whose sandboxes
    /// all run the image of one metadata bundle. `Fixture::start` serves plain
    /// gRPC without a bearer, so the gateway's credential and TLS references
    /// are dropped.
    pub(crate) async fn start_on_cluster(input: &str) -> Self {
        let fixture = Fixture::start().await;
        // OpenShell serves OpenShift with its Kubernetes driver.
        fixture.state.lock().unwrap().driver = Some("kubernetes".into());
        let mut document = Document::parse(input.as_bytes()).unwrap();
        let nemoclaw_sdk::config::Gateway::External(gateway) = &mut document.spec.gateway else {
            panic!("the cluster fixture requires an external gateway")
        };
        assert!(gateway.runtime.provider.is_kubernetes());
        gateway.endpoint = fixture.endpoint.clone();
        gateway.credential = None;
        gateway.tls = None;
        // No engine inspects a cluster's images; the bundle describes them.
        let image_metadata = tempfile::tempdir().unwrap();
        let (image, path) = nemoclaw_e2e::image_runtime::metadata_bundle(image_metadata.path());
        let mut secrets = FixtureSecrets {
            image_metadata: BTreeMap::new(),
        };
        for sandbox in &mut document.spec.sandboxes {
            sandbox.image.ref_ = image.clone();
            secrets.image_metadata.insert(
                sandbox.image.metadata.as_ref().unwrap().env.clone(),
                path.to_string_lossy().into_owned(),
            );
        }
        Self {
            _image_metadata: Some(image_metadata),
            ..Self::new(document, fixture, secrets)
        }
    }

    /// Create a deployment of `document` on `fixture` that records its
    /// progress, without an image engine or metadata bundle.
    fn new(document: Document, fixture: Fixture, secrets: FixtureSecrets) -> Self {
        let bundle =
            PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("explicit bundle path"));
        assert!(bundle.is_absolute());
        let directory = tempfile::tempdir().unwrap();
        let timings = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let received = timings.clone();
        let resource_events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let resources = resource_events.clone();
        let deployment = Deployment::new(directory.path(), &bundle)
            .with_secrets(std::sync::Arc::new(secrets))
            .with_progress(std::sync::Arc::new(move |event| {
                if let nemoclaw_sdk::Progress::Resource {
                    resource,
                    action,
                    status,
                    ..
                } = event
                {
                    resources.lock().unwrap().push((resource, action, status));
                }
                if let nemoclaw_sdk::Progress::Completed {
                    operation, outcome, ..
                } = event
                {
                    received.lock().unwrap().push((operation, outcome));
                }
            }));
        Self {
            cancel: CancellationToken::new(),
            deployment,
            resource_events,
            timings,
            _image_engine: None,
            _image_metadata: None,
            document,
            fixture,
            directory,
            bundle,
        }
    }

    /// Plan without effects, then apply and check its events, health, and timings.
    /// Returns the gateway's effect count after the apply.
    pub(crate) async fn apply(&self) -> usize {
        let planning = self
            .deployment
            .plan(&self.document, &self.cancel)
            .await
            .unwrap();
        assert_eq!(planning.outcome, Outcome::Planned);
        assert_eq!(self.fixture.state.lock().unwrap().effects, 0);
        let applied = self.deployment.apply(&self.document, &self.cancel).await;
        assert!(applied.is_ok(), "{applied:?}");
        assert!(
            self.resource_events
                .lock()
                .unwrap()
                .contains(&("sandbox", "create", "started"))
        );
        assert!(
            self.resource_events
                .lock()
                .unwrap()
                .contains(&("sandbox", "create", "complete"))
        );
        applied.unwrap();
        for operation in [
            "bundle.verify",
            "tofu.init",
            "tofu.plan",
            "tofu.show",
            "tofu.apply",
        ] {
            assert!(
                self.timings
                    .lock()
                    .unwrap()
                    .contains(&(operation, nemoclaw_sdk::StepOutcome::Succeeded)),
                "missing timing for {operation}"
            );
        }
        self.fixture.state.lock().unwrap().effects
    }

    /// The CLI exports the applied document, and reapplying the export changes nothing.
    pub(crate) async fn export_and_reapply_unchanged(&self, effects: usize) {
        let exported = Command::new(
            self.bundle
                .join("bin")
                .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
        )
        .args(["export", "--state-dir"])
        .arg(self.directory.path())
        .output()
        .unwrap();
        assert!(
            exported.status.success(),
            "{}",
            String::from_utf8_lossy(&exported.stderr)
        );
        let exported = Document::parse(exported.stdout.as_slice()).unwrap();
        assert_eq!(exported, self.document);
        assert!(
            self.deployment
                .apply(&exported, &self.cancel)
                .await
                .unwrap()
                .changes
                .is_empty()
        );
        assert_eq!(self.fixture.state.lock().unwrap().effects, effects);
    }

    /// A search profile without endpoints, or a sandbox without its provider
    /// attachments, stops plan and export until the gateway is restored.
    async fn assert_search_registration_drift(&self) {
        let search_provider = self.document.spec.sandboxes[0]
            .integration_bindings(&self.document.spec.integrations)
            .unwrap()
            .iter()
            .find_map(|binding| match binding.definition {
                nemoclaw_sdk::config::Integration::WebSearch(search) => Some(search.provider),
                _ => None,
            })
            .unwrap();
        let state_bytes = fs::read(self.directory.path().join("terraform.tfstate")).unwrap();
        let key = self
            .fixture
            .state
            .lock()
            .unwrap()
            .profiles
            .iter()
            .find(|(_, profile)| {
                nemoclaw_sdk::config::SearchProvider::from_profile(&profile.id)
                    == Some(search_provider)
            })
            .map(|(key, _)| key.clone())
            .unwrap();
        let profile = self.fixture.state.lock().unwrap().profiles[&key].clone();
        self.fixture
            .state
            .lock()
            .unwrap()
            .profiles
            .get_mut(&key)
            .unwrap()
            .endpoints
            .clear();
        assert!(
            self.deployment
                .plan(&self.document, &self.cancel)
                .await
                .is_err()
        );
        assert!(self.deployment.export(&self.cancel).await.is_err());
        assert_eq!(
            fs::read(self.directory.path().join("terraform.tfstate")).unwrap(),
            state_bytes
        );
        self.fixture
            .state
            .lock()
            .unwrap()
            .profiles
            .insert(key, profile);
        let sandbox_key = format!(
            "{}/{}",
            self.document.workspace(),
            self.document.spec.sandboxes[0].name
        );
        let attached = self.fixture.state.lock().unwrap().sandboxes[&sandbox_key]
            .spec
            .as_ref()
            .unwrap()
            .providers
            .clone();
        self.fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .get_mut(&sandbox_key)
            .unwrap()
            .spec
            .as_mut()
            .unwrap()
            .providers
            .clear();
        assert!(
            self.deployment
                .plan(&self.document, &self.cancel)
                .await
                .is_err()
        );
        assert!(self.deployment.export(&self.cancel).await.is_err());
        self.fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .get_mut(&sandbox_key)
            .unwrap()
            .spec
            .as_mut()
            .unwrap()
            .providers = attached;
        assert_eq!(
            self.deployment.export(&self.cancel).await.unwrap(),
            self.document
        );
    }

    /// Broadening one sandbox's tools replaces its agent with its sandbox, and
    /// a failed observation stops plan and export without effects or state
    /// changes.
    async fn assert_tool_policy_drift(&self, effects: usize) {
        let state = fs::read(self.directory.path().join("terraform.tfstate")).unwrap();
        let mut broadened = self.document.clone();
        broadened.spec.sandboxes[1].agent.tools = None;
        let plan = self
            .deployment
            .plan(&broadened, &self.cancel)
            .await
            .unwrap();
        assert_eq!(plan.changes.len(), 3, "{:?}", plan.changes);
        let actions = |prefix: &str| {
            plan.changes
                .iter()
                .find(|change| change.resource.starts_with(prefix))
                .unwrap()
                .actions
                .clone()
        };
        assert_eq!(actions("terraform_data."), ["update"]);
        assert_eq!(actions("openshell_sandbox."), ["delete", "create"]);
        assert_eq!(actions("fabric_agent."), ["delete", "create"]);
        // Reading an agent runs nothing in its sandbox, so a failing exec
        // fails neither a plan nor an export, and changes nothing.
        self.fixture.state.lock().unwrap().exec_exit = 2;
        self.deployment
            .plan(&self.document, &self.cancel)
            .await
            .unwrap();
        assert_eq!(
            self.deployment.export(&self.cancel).await.unwrap(),
            self.document
        );
        assert_eq!(self.fixture.state.lock().unwrap().effects, effects);
        assert_eq!(
            fs::read(self.directory.path().join("terraform.tfstate")).unwrap(),
            state
        );
        self.fixture.state.lock().unwrap().exec_exit = 0;
        assert_eq!(
            self.deployment.export(&self.cancel).await.unwrap(),
            self.document
        );
    }

    /// The first sandbox's Fabric configuration arrives on stdin without the
    /// credential. A configuration changed inside the sandbox outside OpenTofu
    /// is not reported: Fabric reports no applied configuration.
    async fn assert_configuration_on_stdin(&self) {
        let key = format!(
            "{}/{}",
            self.document.workspace(),
            self.document.spec.sandboxes[0].name
        );
        let sandbox_id = self.fixture.state.lock().unwrap().sandboxes[&key]
            .metadata
            .as_ref()
            .unwrap()
            .id
            .clone();
        let original =
            self.fixture.state.lock().unwrap().fabric_configurations[&sandbox_id].clone();
        assert_eq!(
            original,
            nemoclaw_sdk::fabric_config::for_sandbox(
                &self.document,
                &self.document.spec.sandboxes[0]
            )
            .unwrap()
        );
        assert!(!original.to_string().contains("fixture-only-inference-key"));
        {
            // Configuration travels on fabric-agent-ctl start's stdin, not a staged file.
            let state = self.fixture.state.lock().unwrap();
            assert!(
                state
                    .exec_calls
                    .iter()
                    .zip(&state.exec_stdin)
                    .any(|(command, stdin)| {
                        command.first().is_some_and(|entrypoint| {
                            entrypoint == "/opt/fabric/bin/fabric-agent-ctl"
                        }) && command.get(1).is_some_and(|operation| operation == "start")
                            && command
                                .windows(2)
                                .any(|args| args[0] == "--config" && args[1] == "-")
                            && serde_json::from_slice::<serde_json::Value>(stdin).ok()
                                == Some(original.clone())
                    })
            );
        }
    }

    /// The CLI destroys the deployment and its workspace on the gateway.
    pub(crate) fn destroy(self) {
        let destroyed = Command::new(
            self.bundle
                .join("bin")
                .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
        )
        .args(["destroy", "--state-dir"])
        .arg(self.directory.path())
        .output()
        .unwrap();
        assert!(
            destroyed.status.success(),
            "{}",
            String::from_utf8_lossy(&destroyed.stderr)
        );
        let state = self.fixture.state.lock().unwrap();
        assert!(state.workspaces.is_empty());
        assert!(state.sandboxes.is_empty());
        assert!(state.providers.is_empty());
        assert!(state.profiles.is_empty());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn startup_and_observation_failures_retain_bindings_and_recover() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    fixture.state.lock().unwrap().sandbox_phase = Some(openshell_core::proto::SandboxPhase::Error);
    fixture.state.lock().unwrap().sandbox_conditions =
        vec![openshell_core::proto::SandboxCondition {
            r#type: "Ready".into(),
            status: "False".into(),
            reason: "ControlSupervisorExited".into(),
            message: "private-backend-diagnostic".into(),
            ..Default::default()
        }];
    let error = deployment
        .apply(&document, &cancel)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("ControlSupervisorExited"), "{error}");
    assert!(!error.contains("private-backend-diagnostic"));
    let state_path = directory.path().join("terraform.tfstate");
    assert_eq!(fixture.state.lock().unwrap().effects, 4);
    assert_apply_unfinished(&deployment, &cancel).await;
    // Reapplying replaces the exited sandbox; the replacement fails the same way.
    let error = deployment
        .apply(&document, &cancel)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("ControlSupervisorExited"), "{error}");
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.delete_calls, 1);
        assert_eq!(state.sandboxes.len(), 1);
        assert!(state.exec_calls.is_empty());
    }
    fixture.state.lock().unwrap().sandbox_phase = None;
    for sandbox in fixture.state.lock().unwrap().sandboxes.values_mut() {
        sandbox.status.as_mut().unwrap().phase = openshell_core::proto::SandboxPhase::Ready as i32;
    }
    let recovery = deployment.apply(&document, &cancel).await.unwrap();
    // The failed start may have used the sandbox's one runtime, so the retry
    // creates the agent in a new sandbox.
    let action = |prefix: &str| {
        recovery
            .changes
            .iter()
            .find(|change| change.resource.starts_with(prefix))
            .map(|change| change.actions.clone())
    };
    assert_eq!(
        action("openshell_sandbox."),
        Some(vec!["delete".into(), "create".into()])
    );
    assert_eq!(action("fabric_agent."), Some(vec!["create".into()]));
    let recovered = fs::read(&state_path).unwrap();
    let observed: serde_json::Value = serde_json::from_slice(&recovered).unwrap();
    let configuration_count = observed["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|resource| resource["type"] == "fabric_agent")
        .count();
    assert_eq!(configuration_count, 1);
    let effects = fixture.state.lock().unwrap().effects;
    fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unavailable));
    assert!(deployment.export(&cancel).await.is_err());
    assert!(deployment.plan(&document, &cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_eq!(fs::read(&state_path).unwrap(), recovered);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().fail_read = None;
    // Exporting reads agents without running anything in their sandboxes.
    fixture.state.lock().unwrap().exec_truncated = true;
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    fixture.state.lock().unwrap().exec_truncated = false;
    fixture.state.lock().unwrap().lose_delete = true;
    assert!(deployment.destroy(&cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_eq!(
        deployment.destroy(&cancel).await.unwrap().outcome,
        Outcome::Destroyed
    );
    assert!(fixture.state.lock().unwrap().workspaces.is_empty());
    assert!(fixture.state.lock().unwrap().providers.is_empty());
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; exercises a slow graceful sandbox stop"]
async fn destroy_waits_for_graceful_sandbox_stop_without_retrying() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    fixture.state.lock().unwrap().delete_delay = std::time::Duration::from_secs(31);
    assert_eq!(
        deployment.destroy(&cancel).await.unwrap().outcome,
        Outcome::Destroyed
    );
    let state = fixture.state.lock().unwrap();
    assert!(state.sandboxes.is_empty());
    assert!(state.workspaces.is_empty()); // Destroy deletes the workspace too.
    assert_eq!(state.delete_calls, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn mixed_sandboxes_reorder_add_recover_export_and_destroy_independently() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let mut other = document.spec.sandboxes[0].clone();
    other.name = "research".into();
    other.harness.as_mut().unwrap().kind = "nvidia.fabric.langchain.deepagents".parse().unwrap();
    document.spec.sandboxes.push(other.clone());
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    let preview = deployment.plan(&document, &cancel).await.unwrap();
    // Each image/adapter scope owns its provider registration and executable
    // grants; each agent's configuration replaces its sandbox; the new
    // sandbox's image is pulled.
    assert_eq!(preview.changes.len(), 10);
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    deployment.apply(&document, &cancel).await.unwrap();
    let before: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("terraform.tfstate")).unwrap())
            .unwrap();
    document.spec.sandboxes.reverse();
    assert!(
        deployment
            .plan(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    other.name = "third".into();
    document.spec.sandboxes.push(other);
    let added = deployment.plan(&document, &cancel).await.unwrap();
    // The sandbox, its agent, and the agent's configuration.
    assert_eq!(added.changes.len(), 3);
    assert!(
        added
            .changes
            .iter()
            .any(|change| change.resource == "openshell_sandbox.third")
    );
    assert!(
        added
            .changes
            .iter()
            .any(|change| change.resource == "fabric_agent.third")
    );
    fixture.state.lock().unwrap().sandbox_phase = Some(openshell_core::proto::SandboxPhase::Error);
    assert!(deployment.apply(&document, &cancel).await.is_err());
    {
        let mut state = fixture.state.lock().unwrap();
        state.sandbox_phase = None;
        for sandbox in state.sandboxes.values_mut() {
            sandbox.status.as_mut().unwrap().phase =
                openshell_core::proto::SandboxPhase::Ready as i32;
        }
    }
    deployment.apply(&document, &cancel).await.unwrap();
    let after: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("terraform.tfstate")).unwrap())
            .unwrap();
    for resource in before["resources"].as_array().unwrap() {
        let retained = after["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|other| other["type"] == resource["type"] && other["name"] == resource["name"])
            .unwrap();
        assert_eq!(
            retained["instances"][0]["attributes"]["id"],
            resource["instances"][0]["attributes"]["id"]
        );
    }
    let exported = deployment.export(&cancel).await.unwrap();
    assert_eq!(exported, document);
    assert!(
        deployment
            .apply(&exported, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    deployment.destroy(&cancel).await.unwrap();
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn failed_first_apply_can_destroy_bound_resources_without_successful_reapply() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    for sandbox_error in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let fixture = Fixture::start().await;
        let mut document = Document::parse(
            include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
        )
        .unwrap();
        *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
        let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
        if sandbox_error {
            fixture.state.lock().unwrap().sandbox_phase =
                Some(openshell_core::proto::SandboxPhase::Error);
        } else {
            fixture.state.lock().unwrap().exec_exit = 1;
        }
        let deployment = Deployment::new(directory.path(), &bundle);
        let cancel = CancellationToken::new();
        assert!(deployment.apply(&document, &cancel).await.is_err());
        let intent_path = directory.path().join("intent.json");
        let intent = fs::read(&intent_path).unwrap();
        let state_path = directory.path().join("terraform.tfstate");
        let saved = fs::read(&state_path).unwrap();
        let effects = fixture.state.lock().unwrap().effects;
        assert_eq!(effects, 4);
        fixture.state.lock().unwrap().fail_read = Some(("sandbox", tonic::Code::PermissionDenied));
        assert!(deployment.plan_destroy(&cancel).await.is_err());
        assert_eq!(fs::read(&intent_path).unwrap(), intent);
        assert_eq!(fs::read(&state_path).unwrap(), saved);
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        fixture.state.lock().unwrap().fail_read = None;
        let sandboxes = fixture.state.lock().unwrap().sandboxes.clone();
        for field in ["owner", "id"] {
            for sandbox in fixture.state.lock().unwrap().sandboxes.values_mut() {
                let metadata = sandbox.metadata.as_mut().unwrap();
                if field == "owner" {
                    metadata
                        .labels
                        .insert("nemoclaw.nvidia.com/uid".into(), "foreign".into());
                } else {
                    metadata.id = "replacement".into();
                }
            }
            assert!(deployment.plan_destroy(&cancel).await.is_err());
            assert_eq!(fs::read(&intent_path).unwrap(), intent);
            assert_eq!(fs::read(&state_path).unwrap(), saved);
            assert_eq!(fixture.state.lock().unwrap().effects, effects);
            fixture.state.lock().unwrap().sandboxes = sandboxes.clone();
        }
        let preview = deployment
            .plan_destroy(&cancel)
            .await
            .expect("identified failed creations must have a teardown path");
        assert!(
            preview
                .changes
                .iter()
                .any(|change| change.resource == "openshell_sandbox.assistant")
        );
        assert_eq!(fs::read(&intent_path).unwrap(), intent);
        assert_eq!(fs::read(&state_path).unwrap(), saved);
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        let destroyed = deployment.destroy(&cancel).await.unwrap();
        assert_eq!(destroyed.outcome, Outcome::Destroyed);
        let state = fixture.state.lock().unwrap();
        assert!(state.sandboxes.is_empty());
        assert!(state.providers.is_empty());
        assert!(state.profiles.is_empty());
        assert!(state.workspaces.is_empty());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn failed_first_configuration_accepts_corrected_intent_by_replacing_the_sandbox() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    fixture.state.lock().unwrap().exec_exit = 1;
    assert!(deployment.apply(&document, &cancel).await.is_err());
    let sandboxes = fixture.state.lock().unwrap().sandboxes.clone();
    document.spec.sandboxes[0]
        .agent
        .inference
        .as_mut()
        .unwrap()
        .routes[0]
        .overrides
        .model = "corrected-model".into();
    fixture.state.lock().unwrap().exec_exit = 0;
    deployment
        .apply(&document, &cancel)
        .await
        .expect("a corrected agent replaces the sandbox");
    let replaced = fixture.state.lock().unwrap().sandboxes.clone();
    assert_eq!(replaced.len(), 1);
    assert_ne!(replaced, sandboxes);
    let exported = deployment.export(&cancel).await.unwrap();
    assert_eq!(exported, document);
    assert!(
        deployment
            .apply(&exported, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    deployment.destroy(&cancel).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn cli_redaction_preserves_failures_and_recovery_with_short_and_colliding_credentials() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    document.spec.inference_providers[0].endpoint = "https://127.0.0.1:9/v1".into();
    document.spec.inference_providers[0].credential = Some(nemoclaw_sdk::config::SecretRef {
        env: "NEMOCLAW_TEST_REDACTION_KEY".into(),
    });
    let input = directory.path().join("deployment.yaml");
    let state = directory.path().join("state");
    fs::write(&input, document.yaml().unwrap()).unwrap();
    let invoke = |operation: &str, format: &str, secret: &str| {
        let mut command = Command::new(
            bundle
                .join("bin")
                .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
        );
        command
            .args([
                operation,
                "-o",
                format,
                "--progress",
                "plain",
                "--verbose",
                "--state-dir",
            ])
            .arg(&state)
            .arg("--bundle")
            .arg(&bundle)
            .env("NEMOCLAW_TEST_REDACTION_KEY", secret)
            .env("NEMOCLAW_TEST_MARKER_KEY", "redacted");
        if operation == "apply" {
            command.arg(&input).arg("--non-interactive");
        }
        command.output().unwrap()
    };
    let applied = invoke("apply", "json", "a");
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stdout)
    );
    let original = fixture.state.lock().unwrap().sandboxes.clone();
    document.spec.sandboxes[0]
        .agent
        .inference
        .as_mut()
        .unwrap()
        .routes[0]
        .overrides
        .model = "changed-model".into();
    fs::write(&input, document.yaml().unwrap()).unwrap();
    fixture.state.lock().unwrap().configuration_error = Some(serde_json::json!({
        "error": {"stage":"start", "code":"start_failed", "message":"native-secret-must-not-escape"}
    }));
    // The process tests own the credential/context matrix. Keep the native
    // withholding and collision paths here, including failure recovery.
    for (secret, format) in [("a", "text"), ("start_failed", "json")] {
        let failed = invoke("apply", format, secret);
        assert_eq!(failed.status.code(), Some(1));
        let stdout = String::from_utf8(failed.stdout).unwrap();
        let stderr = String::from_utf8(failed.stderr).unwrap();
        let message = if format == "json" {
            let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();
            assert_eq!(result["outcome"], "failed");
            result["error"]["message"].as_str().unwrap().to_owned()
        } else {
            stderr.clone()
        };
        if secret.len() == 1 {
            assert!(
                message.contains(
                    "child diagnostic withheld because a credential is too short for safe redaction"
                ),
                "{message}"
            );
            assert!(
                !message.contains("[redacted]"),
                "short-value character matches must not escape"
            );
        } else {
            assert!(message.contains("sandbox/assistant"), "{message}");
            assert!(message.contains("[redacted]"), "{message}");
            assert!(message.contains("agent runtime is unknown"), "{message}");
            assert!(!message.contains(secret));
        }
        assert!(!message.contains("[[redacted]]"));
        assert!(!stdout.contains("native-secret-must-not-escape"));
        assert!(!stderr.contains("native-secret-must-not-escape"));
    }
    fixture.state.lock().unwrap().configuration_error = None;
    let recovered = invoke("apply", "json", "a");
    assert!(
        recovered.status.success(),
        "{}",
        String::from_utf8_lossy(&recovered.stdout)
    );
    // The changed agent runs in a new sandbox.
    let recovered_sandboxes = fixture.state.lock().unwrap().sandboxes.clone();
    assert_eq!(recovered_sandboxes.len(), 1);
    assert_ne!(recovered_sandboxes, original);
    let destroyed = invoke("destroy", "json", "a");
    assert!(
        destroyed.status.success(),
        "{}",
        String::from_utf8_lossy(&destroyed.stdout)
    );
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway rejection fixture"]
async fn rejected_policy_fails_promptly_with_context_and_allows_recovery_or_destroy() {
    use openshell_core::proto::{
        ConfigurationAdmissionState, SandboxConfigurationAdmission, SandboxPhase,
    };
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    for recover in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let fixture = Fixture::start().await;
        let mut document =
            Document::parse(include_str!("../../../examples/explicit-policy.yaml").as_bytes())
                .unwrap();
        *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
        let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
        let name = document.spec.sandboxes[0].name.clone();
        {
            let mut state = fixture.state.lock().unwrap();
            state.sandbox_phase = Some(SandboxPhase::Starting);
            state.configuration_admission = Some(SandboxConfigurationAdmission {
                state: ConfigurationAdmissionState::Rejected as i32,
                error: "Effective configuration could not be activated; replace the policy or repair attached providers".into(),
                instance_id: "PRIVATE_SENTINEL".into(),
                policy_version: 1,
                ..Default::default()
            });
        }
        let input = directory.path().join("input.yaml");
        let state_dir = directory.path().join("state");
        fs::write(&input, document.yaml().unwrap()).unwrap();
        let deployment = Deployment::new(&state_dir, &bundle);
        let cancel = CancellationToken::new();
        deployment.plan(&document, &cancel).await.unwrap();
        assert_eq!(fixture.state.lock().unwrap().effects, 0);
        let started = std::time::Instant::now();
        let output = Command::new(bundle.join("bin/nemoclaw"))
            .args(["--state-dir"])
            .arg(&state_dir)
            .args([
                "apply",
                "--progress",
                "off",
                "-o",
                if recover { "text" } else { "json" },
            ])
            .arg(&input)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let diagnostic = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            diagnostic.contains("configuration rejected"),
            "{diagnostic}"
        );
        assert!(
            diagnostic.contains(&format!("sandbox/{name}")),
            "{diagnostic}"
        );
        assert!(
            diagnostic.contains("replace the policy or repair attached providers"),
            "{diagnostic}"
        );
        assert!(!diagnostic.contains("PRIVATE_SENTINEL"), "{diagnostic}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(15),
            "known rejection must not wait for the startup deadline"
        );
        let sandboxes = fixture.state.lock().unwrap().sandboxes.clone();
        assert_eq!(sandboxes.len(), 1);
        assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
        if recover {
            // Once OpenShell accepts the policy, the retry creates the agent
            // in a new sandbox: every new agent gets one, even where an
            // earlier start never ran.
            {
                let mut state = fixture.state.lock().unwrap();
                state.sandbox_phase = None;
                state.configuration_admission = None;
            }
            let retried = deployment.apply(&document, &cancel).await.unwrap();
            {
                let state = fixture.state.lock().unwrap();
                assert_eq!(state.sandboxes.len(), 1);
                let id = |sandbox: &openshell_core::proto::Sandbox| {
                    sandbox.metadata.as_ref().unwrap().id.clone()
                };
                assert!(
                    state
                        .sandboxes
                        .values()
                        .all(|current| sandboxes.values().all(|old| id(old) != id(current))),
                    "the retry replaces the rejected sandbox: {:?}",
                    retried.changes
                );
            }
            let exported = deployment.export(&cancel).await.unwrap();
            assert_eq!(exported, document);
            assert!(
                deployment
                    .apply(&exported, &cancel)
                    .await
                    .unwrap()
                    .changes
                    .is_empty()
            );
        }
        deployment.plan_destroy(&cancel).await.unwrap();
        deployment.destroy(&cancel).await.unwrap();
        assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
        let deletes = if recover { 2 } else { 1 };
        assert_eq!(fixture.state.lock().unwrap().delete_calls, deletes);
    }
}

// Text/JSON presentation is checked at the CLI renderer boundary. This native
// case keeps the diagnostic producer, private-detail suppression, retained
// resources, and successful cleanup through the actual executable stack.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn pi_start_failure_names_the_sandbox_in_json_and_allows_destroy() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut input: serde_json::Value = serde_saphyr::from_str(include_str!(
        "../../nemoclaw-sdk/tests/fixtures/config/local.yaml"
    ))
    .unwrap();
    input["spec"]["gateway"]["endpoint"] = fixture.endpoint.clone().into();
    input["spec"]["sandboxes"][0]["name"] = "coder".into();
    input["spec"]["sandboxes"][0]["harness"]["kind"] = "nvidia.fabric.pi".into();
    let mut document = Document::parse(input.to_string().as_bytes()).unwrap();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let input = directory.path().join("input.yaml");
    fs::write(&input, document.yaml().unwrap()).unwrap();
    let state = directory.path().join("state");
    fixture.state.lock().unwrap().configuration_error = Some(serde_json::json!({
        "error": {"stage":"start", "code":"start_failed", "message":"PRIVATE_SENTINEL", "details":{"token":"PRIVATE_SENTINEL"}}
    }));
    let invoke = |operation: &str| {
        let mut command = Command::new(
            bundle
                .join("bin")
                .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
        );
        command
            .arg("--bundle")
            .arg(&bundle)
            .arg("--state-dir")
            .arg(&state)
            .args(["--progress", "off", operation, "-o", "json"]);
        if operation == "apply" {
            command.arg(&input).arg("--non-interactive");
        }
        command.output().unwrap()
    };
    let failed = invoke("apply");
    assert_eq!(failed.status.code(), Some(1));
    let stdout = String::from_utf8(failed.stdout).unwrap();
    let stderr = String::from_utf8(failed.stderr).unwrap();
    let report: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(report["outcome"], "failed");
    let remaining = report["remainingState"].as_str().unwrap();
    assert!(
        remaining.contains("Changes may already have been made"),
        "{remaining}"
    );
    assert!(
        !remaining.contains("No runtime resources changed"),
        "{remaining}"
    );
    let message = report["error"]["message"].as_str().unwrap();
    for expected in [
        "sandbox/coder",
        "start",
        "start_failed",
        "agent runtime is unknown",
        "resources retained",
    ] {
        assert!(message.contains(expected), "{message}");
    }
    assert!(!stdout.contains("PRIVATE_SENTINEL") && !stderr.contains("PRIVATE_SENTINEL"));
    assert_eq!(fixture.state.lock().unwrap().sandboxes.len(), 1);
    assert!(state.join("terraform.tfstate").exists());
    let destroyed = invoke("destroy");
    assert!(
        destroyed.status.success(),
        "{} {}",
        String::from_utf8_lossy(&destroyed.stdout),
        String::from_utf8_lossy(&destroyed.stderr)
    );
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn sandbox_startup_failure_names_reason_and_guidance_and_allows_destroy() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    for (format, reason, guidance) in [
        (
            "text",
            "IdentityResolutionFailed",
            "check policy.process.run_as_user and run_as_group",
        ),
        (
            "json",
            "ControlSupervisorStartFailed",
            "check the sandbox policy and attached providers",
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let fixture = Fixture::start().await;
        let mut input: serde_json::Value = serde_saphyr::from_str(include_str!(
            "../../nemoclaw-sdk/tests/fixtures/config/local.yaml"
        ))
        .unwrap();
        input["spec"]["gateway"]["endpoint"] = fixture.endpoint.clone().into();
        input["spec"]["sandboxes"][0]["name"] = "coder".into();
        let mut document = Document::parse(input.to_string().as_bytes()).unwrap();
        let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
        let input = directory.path().join("input.yaml");
        fs::write(&input, document.yaml().unwrap()).unwrap();
        let state = directory.path().join("state");
        {
            let mut fixture_state = fixture.state.lock().unwrap();
            fixture_state.sandbox_phase = Some(openshell_core::proto::SandboxPhase::Error);
            fixture_state.sandbox_conditions = vec![openshell_core::proto::SandboxCondition {
                r#type: "Ready".into(),
                status: "False".into(),
                reason: reason.into(),
                message: "PRIVATE_SENTINEL".into(),
                ..Default::default()
            }];
        }
        let invoke = |operation: &str| {
            let mut command = Command::new(
                bundle
                    .join("bin")
                    .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
            );
            command
                .arg("--bundle")
                .arg(&bundle)
                .arg("--state-dir")
                .arg(&state)
                .args(["--progress", "off", operation, "-o", format]);
            if matches!(operation, "apply" | "plan") {
                command.arg(&input);
            }
            if operation == "apply" {
                command.arg("--non-interactive");
            }
            command.output().unwrap()
        };
        for operation in ["apply"] {
            let failed = invoke(operation);
            assert_eq!(failed.status.code(), Some(1));
            let stdout = String::from_utf8(failed.stdout).unwrap();
            let stderr = String::from_utf8(failed.stderr).unwrap();
            let message = if format == "json" {
                let report: serde_json::Value = serde_json::from_str(&stdout).unwrap();
                assert_eq!(report["outcome"], "failed");
                report["error"]["message"].as_str().unwrap().to_owned()
            } else {
                stderr.clone()
            };
            for expected in [
                "sandbox/coder",
                "SANDBOX_PHASE_ERROR",
                reason,
                guidance,
                "resources retained",
            ] {
                assert!(message.contains(expected), "{message}");
            }
            assert!(!stdout.contains("PRIVATE_SENTINEL") && !stderr.contains("PRIVATE_SENTINEL"));
            assert_eq!(fixture.state.lock().unwrap().sandboxes.len(), 1);
            assert!(state.join("terraform.tfstate").exists());
        }
        // The plan replaces the exited sandbox and says why, without the
        // backend's private message.
        let before = fixture.state.lock().unwrap().effects;
        let planned = invoke("plan");
        let stdout = String::from_utf8(planned.stdout).unwrap();
        let stderr = String::from_utf8(planned.stderr).unwrap();
        assert!(planned.status.success(), "{stdout} {stderr}");
        let exited = format!("sandbox exited: SANDBOX_PHASE_ERROR, reason {reason}");
        assert!(stdout.contains(&exited), "{stdout}");
        assert!(!stdout.contains("PRIVATE_SENTINEL") && !stderr.contains("PRIVATE_SENTINEL"));
        assert_eq!(fixture.state.lock().unwrap().effects, before);
        let destroyed = invoke("destroy");
        assert!(
            destroyed.status.success(),
            "{} {}",
            String::from_utf8_lossy(&destroyed.stdout),
            String::from_utf8_lossy(&destroyed.stderr)
        );
        assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn scoped_provider_labels_preserve_authored_identity() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut input: serde_json::Value = serde_saphyr::from_str(include_str!(
        "../../nemoclaw-sdk/tests/fixtures/config/local.yaml"
    ))
    .unwrap();
    input["spec"]["gateway"]["endpoint"] = fixture.endpoint.clone().into();
    let mut provider = input["spec"]["inferenceProviders"][0].take();
    provider["name"] = "responses".into();
    input["spec"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders");
    input["spec"]["sandboxes"][0]["inferenceProviders"] = serde_json::json!([provider]);
    input["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["providerRef"] =
        "responses".into();
    let mut document = Document::parse(input.to_string().as_bytes()).unwrap();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let state = directory.path().join("state");
    let input = directory.path().join("input.yaml");
    fs::write(&input, document.yaml().unwrap()).unwrap();
    let deployment = Deployment::new(&state, &bundle);
    let cancel = CancellationToken::new();
    let preview = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["--progress", "off", "--state-dir"])
    .arg(&state)
    .args(["plan", "--non-interactive"])
    .arg(&input)
    .output()
    .unwrap();
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    let text = String::from_utf8(preview.stdout).unwrap();
    assert!(
        text.contains(
            "provider/responses at spec.sandboxes[assistant].inferenceProviders[responses]"
        ),
        "{text}"
    );
    assert!(!text.contains("provider/local-"), "{text}");
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    deployment.apply(&document, &cancel).await.unwrap();
}
