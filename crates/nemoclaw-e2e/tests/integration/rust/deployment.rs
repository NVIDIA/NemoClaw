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
        include_str!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
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
    assert!(summary.contains("No resource changes"), "{summary}");
    assert_eq!(fixture.state.lock().unwrap().effects, effects);

    let destroyed = invoke("destroy", "text");
    let summary = String::from_utf8(destroyed.stdout).unwrap();
    assert!(summary.contains("Destroy complete"), "{summary}");
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
async fn gateway_change_between_plan_and_apply_preserves_resources_and_allows_teardown() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
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
        include_str!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
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
    changed
        .spec
        .inference_providers
        .get_mut("local")
        .unwrap()
        .endpoint = "http://172.20.0.1:11437/v1".into();
    let error = deployment.apply(&changed, &cancel).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("unfinished creation requires its original resource configuration"),
        "{error}"
    );
    // A change that leaves every pending target as it was is accepted, and
    // the apply finishes the interrupted creation.
    document.metadata.name = "revised-unrelated-description".into();
    deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(
        deployment.destroy(&cancel).await.unwrap().outcome,
        Outcome::Destroyed
    );
    assert!(fixture.state.lock().unwrap().workspaces.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn shell_restriction_and_restore_replace_only_the_target_sandbox() {
    let mut document =
        Document::parse(include_str!("../../../../../examples/fabric-openclaw.yaml").as_bytes())
            .unwrap();
    // Tool names belong to the adapter, not the SDK or the gateway fixture.
    document
        .spec
        .sandboxes
        .get_mut("assistant")
        .unwrap()
        .agent
        .tools = Some(nemoclaw_sdk::config::AgentTools {
        allow: vec![
            "fixture.file-read".into(),
            "fixture.shell-launch".into(),
            "fixture.lookup".into(),
        ],
    });
    let mut reader = document.spec.sandboxes["assistant"].clone();
    reader.agent.name = "reader".into();
    // An exposure on the unrelated sandbox gives the gateway a service endpoint
    // that neither transition may touch.
    reader.service_exposures =
        serde_json::from_value(serde_json::json!({"dashboard": {"targetPort": 18800}})).unwrap();
    document.spec.sandboxes.insert("reader".into(), reader);
    let lifecycle = Lifecycle::start(&document.yaml().unwrap()).await;
    lifecycle.apply().await;
    let mut restricted = lifecycle.document.clone();
    restricted
        .spec
        .sandboxes
        .get_mut("assistant")
        .unwrap()
        .agent
        .tools
        .as_mut()
        .unwrap()
        .allow
        .retain(|tool| tool != "fixture.shell-launch");
    let target = format!("{}/assistant", lifecycle.document.workspace());

    for (phase, document) in [("restrict", &restricted), ("restore", &lifecycle.document)] {
        let (mut sandboxes, workspaces, providers, profiles, services, creates, effects) = {
            let state = lifecycle.fixture.state.lock().unwrap();
            (
                state.sandboxes.clone(),
                state.workspaces.clone(),
                state.providers.clone(),
                state.profiles.clone(),
                state.services.clone(),
                state.created_sandboxes.len(),
                state.effects,
            )
        };
        let previous = sandboxes.remove(&target).unwrap().metadata.unwrap().id;
        for (kind, empty) in [
            ("sandboxes", sandboxes.is_empty()),
            ("workspaces", workspaces.is_empty()),
            ("inference registrations", providers.is_empty()),
            ("provider profiles", profiles.is_empty()),
            ("service endpoints", services.is_empty()),
        ] {
            assert!(!empty, "{phase}: no unrelated {kind} to compare");
        }
        let planned = lifecycle
            .deployment
            .plan(document, &lifecycle.cancel)
            .await
            .unwrap();
        assert_eq!(
            lifecycle.fixture.state.lock().unwrap().effects,
            effects,
            "{phase}: planning must not mutate the gateway"
        );
        let changes = |result: &nemoclaw_sdk::OperationResult| -> BTreeMap<String, Vec<String>> {
            result
                .changes
                .iter()
                .map(|change| (change.resource.clone(), change.actions.clone()))
                .collect()
        };
        let expected = BTreeMap::from([
            (
                "fabric_agent.assistant".into(),
                vec!["delete".into(), "create".into()],
            ),
            (
                "openshell_sandbox.assistant".into(),
                vec!["delete".into(), "create".into()],
            ),
            (
                "terraform_data.agent_assistant".into(),
                vec!["update".into()],
            ),
        ]);
        assert_eq!(
            changes(&planned),
            expected,
            "{phase}: only the target agent, sandbox, and configuration trigger change"
        );
        let applied = lifecycle
            .deployment
            .apply(document, &lifecycle.cancel)
            .await
            .unwrap();
        assert_eq!(
            applied.changes, planned.changes,
            "{phase}: apply must match the plan"
        );
        let state = lifecycle.fixture.state.lock().unwrap();
        assert_eq!(
            state.created_sandboxes.len(),
            creates + 1,
            "{phase}: exactly one sandbox created"
        );
        let mut current = state.sandboxes.clone();
        let replacement = current.remove(&target).unwrap().metadata.unwrap().id;
        assert_ne!(
            replacement, previous,
            "{phase}: target sandbox must be replaced"
        );
        assert_eq!(
            current, sandboxes,
            "{phase}: unrelated sandboxes must stay unchanged"
        );
        assert_eq!(
            state.workspaces, workspaces,
            "{phase}: workspaces must stay unchanged"
        );
        assert_eq!(
            state.providers, providers,
            "{phase}: inference registrations must stay unchanged"
        );
        assert_eq!(
            state.profiles, profiles,
            "{phase}: provider profiles must stay unchanged"
        );
        assert_eq!(
            state.services, services,
            "{phase}: service endpoints must stay unchanged"
        );
    }
    lifecycle
        .deployment
        .destroy(&lifecycle.cancel)
        .await
        .unwrap();
}

/// One document carries the authored settings that export must reproduce:
/// web search and API integrations, an authored inference API, native harness
/// settings, network grants, service exposures, and a second sandbox's tool
/// limit. The bundle's CLI exports what the SDK applied, and reapplying the
/// export changes nothing. Each kind of observed drift then stops plan and
/// export without gateway effects or a change to saved state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn authored_settings_survive_cli_export_and_drift_stops_plan_and_export() {
    let mut document =
        Document::parse(include_str!("../../../../../examples/fabric-openclaw.yaml").as_bytes())
            .unwrap();
    document.spec.integrations = serde_json::from_value(serde_json::json!({
        "search": {"kind":"webSearch", "provider":"tavily", "credential":{"env":"SEARCH_KEY"}},
        "bookings": {"kind":"api", "endpoint":"https://bookings.example.com/mcp",
            "credential":{"env":"BOOKINGS_API_KEY"}}
    }))
    .unwrap();
    document
        .spec
        .inference_providers
        .get_mut("local")
        .unwrap()
        .api = Some(nemoclaw_sdk::config::InferenceApi::OpenaiCompletions);
    let mut reader = document.spec.sandboxes["assistant"].clone();
    reader.agent.name = "reader".into();
    reader.agent.tools = Some(nemoclaw_sdk::config::AgentTools {
        allow: vec!["read".into()],
    });
    let sandbox = document.spec.sandboxes.get_mut("assistant").unwrap();
    sandbox.agent.integration_refs = vec!["search".into(), "bookings".into()];
    sandbox.harness.as_mut().unwrap().settings = Some(
        serde_json::from_value(serde_json::json!({"native_config":{"tools":{"toolSearch":
            {"mode":"tools","searchDefaultLimit":8,"maxSearchLimit":20}}}}))
        .unwrap(),
    );
    sandbox.network = serde_json::from_value(serde_json::json!({
        "tier": "isolated",
        "grants": {"docs": {"endpoints": [{
            "host": "docs.example.com", "port": 443, "protocol": "rest", "enforcement": "enforce",
            "rules": [{"allow": {"method": "GET", "path": "/**"}}]
        }]}}
    }))
    .unwrap();
    sandbox.service_exposures = serde_json::from_value(serde_json::json!({
        "dashboard": {"targetPort": 18800},
        "api": {"targetPort": 8642, "authorizationMode": "BEARER_PASSTHROUGH"}
    }))
    .unwrap();
    document.spec.sandboxes.insert("reader".into(), reader);
    let lifecycle = Lifecycle::start(&document.yaml().unwrap()).await;
    let created = lifecycle.apply_result().await;
    let effects = lifecycle.fixture.state.lock().unwrap().effects;
    // The assistant's creation carries its exposures; an omitted mode stays
    // omitted, so OpenShell applies its own default.
    let mut seen: Vec<_> = lifecycle
        .fixture
        .state
        .lock()
        .unwrap()
        .sandbox_exposures
        .iter()
        .flatten()
        .map(|exposure| {
            (
                exposure.service.clone(),
                exposure.target_port,
                exposure.authorization_mode,
            )
        })
        .collect();
    seen.sort();
    assert_eq!(
        seen,
        [
            (
                "api".to_owned(),
                8642,
                openshell_core::proto::ServiceAuthorizationMode::BearerPassthrough as i32
            ),
            (
                "dashboard".to_owned(),
                18800,
                openshell_core::proto::ServiceAuthorizationMode::Unspecified as i32
            ),
        ]
    );
    // The first apply and the unchanged one report the URLs the fixture
    // gateway gave each exposure, read back from state.
    let workspace = lifecycle.document.workspace();
    let url =
        |service: &str| format!("http://{workspace}--assistant--{service}.services.fixture.test/");
    let expected: BTreeMap<_, _> = [(
        "assistant".to_owned(),
        [("api", url("api")), ("dashboard", url("dashboard"))]
            .map(|(service, url)| (service.to_owned(), url))
            .into(),
    )]
    .into();
    assert_eq!(created.service_urls, expected);
    let unchanged = lifecycle.export_and_reapply_unchanged(effects).await;
    assert_eq!(unchanged.service_urls, expected);
    lifecycle.assert_drift_stops_plan_and_export(effects).await;
    lifecycle.destroy();
}

/// Progress events that the deployment's callback records.
type Recorded<T> = std::sync::Arc<std::sync::Mutex<Vec<T>>>;

/// A deployment through the SDK and the bundle's CLI against the fixture gateway.
/// Fields drop in declaration order: the deployment before the image engine,
/// gateway, and state directory.
pub(crate) struct Lifecycle {
    pub(crate) cancel: CancellationToken,
    pub(crate) deployment: Deployment,
    resource_events: Recorded<(&'static str, &'static str, &'static str)>,
    timings: Recorded<(&'static str, nemoclaw_sdk::StepOutcome)>,
    _image_engine: nemoclaw_e2e::http_fixture::Fixture,
    pub(crate) document: Document,
    pub(crate) fixture: Fixture,
    pub(crate) directory: tempfile::TempDir,
    pub(crate) bundle: PathBuf,
}

/// Fixture values for the credentials the tests reference.
struct FixtureSecrets;
impl nemoclaw_sdk::Secrets for FixtureSecrets {
    fn resolve(&self, name: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
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
        let bundle =
            PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("explicit bundle path"));
        assert!(bundle.is_absolute());
        let directory = tempfile::tempdir().unwrap();
        let timings = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let received = timings.clone();
        let resource_events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let resources = resource_events.clone();
        let deployment = Deployment::new(directory.path(), &bundle)
            .with_secrets(std::sync::Arc::new(FixtureSecrets))
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
            _image_engine: image_engine,
            document,
            fixture,
            directory,
            bundle,
        }
    }

    /// Plan without effects, then apply and check its events, health, and timings.
    /// Returns the gateway's effect count after the apply.
    pub(crate) async fn apply(&self) -> usize {
        self.apply_result().await;
        self.fixture.state.lock().unwrap().effects
    }

    /// As `apply`, returning the apply's result.
    pub(crate) async fn apply_result(&self) -> nemoclaw_sdk::OperationResult {
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
        let applied = applied.unwrap();
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
        applied
    }

    /// The CLI exports the applied document, and reapplying the export changes
    /// nothing. Returns the reapply's result.
    pub(crate) async fn export_and_reapply_unchanged(
        &self,
        effects: usize,
    ) -> nemoclaw_sdk::OperationResult {
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
        let reapplied = self
            .deployment
            .apply(&exported, &self.cancel)
            .await
            .unwrap();
        assert!(reapplied.changes.is_empty(), "{:?}", reapplied.changes);
        assert_eq!(self.fixture.state.lock().unwrap().effects, effects);
        reapplied
    }

    /// Each kind of drift the gateway reports stops plan and export, without
    /// gateway effects or a change to saved state: a search profile without
    /// endpoints, a sandbox without its provider attachments or with a changed
    /// environment, and a failing runtime check. Restoring the gateway lets
    /// export reproduce the document again.
    async fn assert_drift_stops_plan_and_export(&self, effects: usize) {
        type Drift = fn(&mut nemoclaw_e2e::openshell::State, &str);
        let drifts: [(&str, Drift); 4] = [
            ("search profile without endpoints", |state, _| {
                for profile in state.profiles.values_mut() {
                    if nemoclaw_sdk::config::SearchProvider::from_profile(&profile.id).is_some() {
                        profile.endpoints.clear();
                    }
                }
            }),
            ("sandbox without provider attachments", |state, key| {
                let spec = state.sandboxes.get_mut(key).unwrap().spec.as_mut().unwrap();
                spec.providers.clear();
            }),
            ("changed sandbox environment", |state, key| {
                let spec = state.sandboxes.get_mut(key).unwrap().spec.as_mut().unwrap();
                let value = spec.environment.values_mut().next().unwrap();
                *value = "changed".into();
            }),
            ("failing runtime check", |state, _| state.exec_exit = 2),
        ];
        let saved = || fs::read(self.directory.path().join("terraform.tfstate")).unwrap();
        let before = saved();
        let key = format!("{}/assistant", self.document.workspace());
        for (drift, change) in drifts {
            let (profiles, sandboxes) = {
                let mut state = self.fixture.state.lock().unwrap();
                let kept = (state.profiles.clone(), state.sandboxes.clone());
                change(&mut state, &key);
                kept
            };
            assert!(
                self.deployment
                    .plan(&self.document, &self.cancel)
                    .await
                    .is_err(),
                "{drift}: plan"
            );
            assert!(
                self.deployment.export(&self.cancel).await.is_err(),
                "{drift}: export"
            );
            assert!(saved() == before, "{drift} changed saved state");
            let mut state = self.fixture.state.lock().unwrap();
            assert_eq!(state.effects, effects, "{drift} changed the gateway");
            (state.profiles, state.sandboxes, state.exec_exit) = (profiles, sandboxes, 0);
        }
        assert_eq!(
            self.deployment.export(&self.cancel).await.unwrap(),
            self.document
        );
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
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn failed_first_apply_can_destroy_bound_resources_without_successful_reapply() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    // The sandbox startup failure test owns a failed sandbox; this one fails
    // the agent's start, after the sandbox exists.
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    fixture.state.lock().unwrap().exec_exit = 1;
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    assert!(deployment.apply(&document, &cancel).await.is_err());
    let intent_path = directory.path().join("intent.json");
    let intent = fs::read(&intent_path).unwrap();
    let state_path = directory.path().join("terraform.tfstate");
    let saved = fs::read(&state_path).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn cli_redaction_withholds_short_and_colliding_credentials() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let provider = document.spec.inference_providers.get_mut("local").unwrap();
    provider.endpoint = "https://127.0.0.1:9/v1".into();
    provider.credential = Some(nemoclaw_sdk::config::SecretRef {
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
    document
        .spec
        .sandboxes
        .get_mut("assistant")
        .unwrap()
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
    // withholding and collision paths here; the Fabric start failure test owns
    // recovery.
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
        let mut document = Document::parse(
            include_str!("../../../../../examples/explicit-policy.yaml").as_bytes(),
        )
        .unwrap();
        *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
        let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
        let name = "assistant";
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
        }
        deployment.plan_destroy(&cancel).await.unwrap();
        deployment.destroy(&cancel).await.unwrap();
        assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
        let deletes = if recover { 2 } else { 1 };
        assert_eq!(fixture.state.lock().unwrap().delete_calls, deletes);
    }
}

/// A sandbox that exits during startup: the CLI's JSON report and plan name the
/// sandbox, phase, reason, and guidance without the backend's private message,
/// and the apply stays unfinished. A retry replaces the exited sandbox, and once
/// the gateway admits it, the agent starts in a new sandbox. Failed or cut-off
/// observations stop export, plan, and apply without changing state, and a
/// lost delete leaves a destroy that a retry finishes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn a_sandbox_startup_failure_is_reported_safely_retained_and_recovered() {
    const REASON: &str = "ControlSupervisorStartFailed";
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let input = directory.path().join("input.yaml");
    fs::write(&input, document.yaml().unwrap()).unwrap();
    let state = directory.path().join("state");
    let deployment = Deployment::new(&state, &bundle);
    let cancel = CancellationToken::new();
    {
        let mut fixture_state = fixture.state.lock().unwrap();
        fixture_state.sandbox_phase = Some(openshell_core::proto::SandboxPhase::Error);
        fixture_state.sandbox_conditions = vec![openshell_core::proto::SandboxCondition {
            r#type: "Ready".into(),
            status: "False".into(),
            reason: REASON.into(),
            message: "PRIVATE_SENTINEL".into(),
            ..Default::default()
        }];
    }
    let invoke = |operation: &str, format: &str| {
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
            .args([
                "--progress",
                "off",
                operation,
                "-o",
                format,
                "--non-interactive",
            ])
            .arg(&input);
        let output = command.output().unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(
            !stdout.contains("PRIVATE_SENTINEL") && !stderr.contains("PRIVATE_SENTINEL"),
            "{stdout} {stderr}"
        );
        (output.status.code(), stdout, stderr)
    };

    let (code, stdout, _) = invoke("apply", "json");
    assert_eq!(code, Some(1));
    let report: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(report["outcome"], "failed");
    let message = report["error"]["message"].as_str().unwrap();
    for expected in [
        "sandbox/assistant",
        "SANDBOX_PHASE_ERROR",
        REASON,
        "check the sandbox policy and attached providers",
        "resources retained",
    ] {
        assert!(message.contains(expected), "{message}");
    }
    assert_apply_unfinished(&deployment, &cancel).await;

    // The plan replaces the exited sandbox and says why.
    let effects = fixture.state.lock().unwrap().effects;
    let (code, stdout, stderr) = invoke("plan", "text");
    assert_eq!(code, Some(0), "{stdout} {stderr}");
    assert!(
        stdout.contains(&format!(
            "sandbox exited: SANDBOX_PHASE_ERROR, reason {REASON}"
        )),
        "{stdout}"
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);

    // A retry replaces the exited sandbox; the replacement fails the same way.
    let error = deployment
        .apply(&document, &cancel)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains(REASON), "{error}");
    {
        let fixture_state = fixture.state.lock().unwrap();
        assert_eq!(fixture_state.delete_calls, 1);
        assert_eq!(fixture_state.sandboxes.len(), 1);
        assert!(fixture_state.exec_calls.is_empty());
    }

    // Once the gateway admits the sandbox, the failed start may have left a
    // runtime running, so the agent starts in a new sandbox.
    fixture.state.lock().unwrap().sandbox_phase = None;
    for sandbox in fixture.state.lock().unwrap().sandboxes.values_mut() {
        sandbox.status.as_mut().unwrap().phase = openshell_core::proto::SandboxPhase::Ready as i32;
    }
    let recovery = deployment.apply(&document, &cancel).await.unwrap();
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

    let state_path = state.join("terraform.tfstate");
    let recovered = fs::read(&state_path).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unavailable));
    assert!(deployment.export(&cancel).await.is_err());
    assert!(deployment.plan(&document, &cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_eq!(fs::read(&state_path).unwrap(), recovered);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().fail_read = None;
    // A runtime check whose reply is cut off leaves the agent unobserved.
    fixture.state.lock().unwrap().exec_truncated = true;
    assert!(deployment.export(&cancel).await.is_err());
    assert_eq!(fs::read(&state_path).unwrap(), recovered);
    fixture.state.lock().unwrap().exec_truncated = false;

    fixture.state.lock().unwrap().lose_delete = true;
    assert!(deployment.destroy(&cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_eq!(
        deployment.destroy(&cancel).await.unwrap().outcome,
        Outcome::Destroyed
    );
    let fixture_state = fixture.state.lock().unwrap();
    assert!(fixture_state.workspaces.is_empty());
    assert!(fixture_state.providers.is_empty());
    assert!(fixture_state.sandboxes.is_empty());
}
