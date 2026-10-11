// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fault injection exercises the bundled Helm provider, saved OpenTofu plans,
//! and the public SDK destroy entry point against a loopback Kubernetes API.

use crate::deployment::*;
use crate::kubernetes::gateway;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

#[path = "../../../../../test-support/kube_api.rs"]
mod kube_api;
#[path = "../../../../../test-support/http.rs"]
mod transport;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    Healthy,
    Offline,
    Forbidden,
}

struct Api {
    objects: kube_api::Objects,
    fault: Arc<Mutex<Fault>>,
    failures: Arc<AtomicUsize>,
    mutations: Arc<AtomicUsize>,
    _server: transport::Fixture,
}

impl Api {
    async fn start() -> Self {
        let objects = kube_api::Objects::default();
        objects.insert(json!({"apiVersion":"v1", "kind":"Namespace",
            "metadata":{"name":"kube-system", "uid":"fixture-cluster"}}));
        objects.insert(json!({"apiVersion":"storage.k8s.io/v1", "kind":"StorageClass",
            "metadata":{"name":"standard", "annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}));
        objects.insert(
            json!({"apiVersion":"apiextensions.k8s.io/v1", "kind":"CustomResourceDefinition",
            "metadata":{"name":"sandboxes.agents.x-k8s.io"}}),
        );
        objects.insert(json!({"apiVersion":"apps/v1", "kind":"Deployment",
            "metadata":{"name":"agent-sandbox-controller", "namespace":"agent-sandbox-system"},
            "status":{"availableReplicas":1}}));
        let fault = Arc::new(Mutex::new(Fault::Healthy));
        let failures = Arc::new(AtomicUsize::new(0));
        let mutations = Arc::new(AtomicUsize::new(0));
        let state = (
            objects.clone(),
            fault.clone(),
            failures.clone(),
            mutations.clone(),
        );
        let server = transport::Fixture::start_tcp(move |request| {
            let (objects, fault, failures, mutations) = &state;
            if request.method != "GET" {
                mutations.fetch_add(1, Ordering::Relaxed);
            }
            let fault = *fault.lock().unwrap();
            // The independent NemoClaw metadata observation must remain healthy
            // when only Helm's full release lookup loses permission.
            let helm_lookup = request.method == "GET"
                && request.path.contains("/secrets?")
                && request.path.contains("labelSelector=")
                && !request.header("accept").unwrap_or("").contains("PartialObjectMetadata");
            if fault == Fault::Offline || (fault == Fault::Forbidden && helm_lookup) {
                failures.fetch_add(1, Ordering::Relaxed);
                return if fault == Fault::Offline { None } else {
                    Some((403, json!({"kind":"Status", "apiVersion":"v1", "status":"Failure",
                        "reason":"Forbidden", "code":403, "message":"fixture denies Helm release lookup"}).to_string().into_bytes()))
                };
            }
            if request.path == "/version" {
                return Some((200, json!({"major":"1", "minor":"37", "gitVersion":"v1.37.0"}).to_string().into_bytes()));
            }
            if request.method == "PUT" {
                // client-go sends protobuf for the release-status update.
                // These empty-manifest fixtures only need to acknowledge it;
                // release presence continues to depend on its later deletion.
                let path = request.path.split('?').next().unwrap();
                let object = objects.0.lock().unwrap().get(path).unwrap().clone();
                return Some((200, object.to_string().into_bytes()));
            }
            let answer = objects.answer(&request.method, &request.path, &request.body);
            if helm_lookup {
                let mut list: Value = serde_json::from_slice(&answer.as_ref().unwrap().1).unwrap();
                list["kind"] = json!("SecretList");
                return Some((200, list.to_string().into_bytes()));
            }
            answer
        }).await;
        Self {
            objects,
            fault,
            failures,
            mutations,
            _server: server,
        }
    }

    fn release(&self, name: &str, namespace: &str) {
        // Helm accepts its original uncompressed JSON storage format. The
        // release has no workloads: these tests qualify recovery, not a chart.
        let release = json!({
            "name": name, "namespace": namespace, "version":1,
            "info":{"status":"deployed", "description":"recovery fixture",
                "first_deployed":"2026-01-01T00:00:00Z", "last_deployed":"2026-01-01T00:00:00Z"},
            "chart":{"metadata":{"name":gateway::CHART, "version":"0.0.115", "apiVersion":"v2"}},
            "config":{}, "manifest":"", "hooks":[]
        });
        self.objects.insert(
            json!({"apiVersion":"v1", "kind":"Secret", "type":"helm.sh/release.v1",
            "metadata":{"name":format!("sh.helm.release.v1.{name}.v1"), "namespace":namespace,
                "labels":{"owner":"helm", "name":name, "status":"deployed", "version":"1"}},
            "data":{"release":STANDARD.encode(STANDARD.encode(release.to_string()))}}),
        );
    }
}

struct Kubeconfig(String);
impl Secrets for Kubeconfig {
    fn resolve(&self, name: &str) -> Result<String, crate::ObservationError> {
        assert_eq!(
            name, "TEST_KUBECONFIG",
            "teardown requested an unrelated credential"
        );
        Ok(self.0.clone())
    }
}

struct Fixture {
    api: Api,
    deployment: Deployment,
    directory: tempfile::TempDir,
    name: String,
    namespace: String,
}

impl Fixture {
    async fn create() -> Self {
        let bundle_directory = PathBuf::from(
            std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("explicit verified bundle"),
        );
        let api = Api::start().await;
        let directory = tempfile::tempdir().unwrap();
        let kubeconfig = directory.path().join("fixture.kubeconfig");
        atomic_write(&kubeconfig, serde_json::to_vec(&json!({
            "apiVersion":"v1", "kind":"Config", "current-context":"test-cluster",
            "clusters":[{"name":"fixture", "cluster":{"server":api._server.endpoint}}],
            "contexts":[{"name":"test-cluster", "context":{"cluster":"fixture", "user":"fixture"}}],
            "users":[{"name":"fixture", "user":{}}]
        })).unwrap().as_slice()).unwrap();
        let deployment = Deployment::new(&directory.path().join("state"), &bundle_directory)
            .with_secrets(Arc::new(Kubeconfig(
                kubeconfig.to_string_lossy().into_owned(),
            )));
        let (bundle, store) = deployment.open().unwrap();
        let (document, _) = crate::deployment::tests::kubernetes_context();
        let mut record = Record::new(document).unwrap();
        record.begin_runtime_apply(&record.document.clone());
        store.save(&record).unwrap();
        let stage = Store::open(&store.directory.join("runtime")).unwrap();
        let graph = compile::compile_runtime(
            &record.document,
            &record.generations,
            &bundle.manifest.version,
        )
        .unwrap();
        let cancel = CancellationToken::new();
        deployment
            .initialize(&bundle, &stage, &graph, &cancel)
            .await
            .unwrap();
        let environment = super::super::teardown::destroy_environment(&record.document);
        deployment
            .tofu(
                &bundle,
                &stage,
                &environment,
                &[
                    "apply",
                    "-input=false",
                    "-no-color",
                    "-auto-approve",
                    "-target=nemoclaw_kubernetes_auth.runtime",
                ],
                &cancel,
            )
            .await
            .expect("fixture preparation must use the actual NemoClaw provider");
        let name = graph["resource"]["helm_release"]["gateway"]["name"]
            .as_str()
            .unwrap()
            .to_owned();
        let namespace = record
            .document
            .spec
            .gateway
            .as_kubernetes()
            .unwrap()
            .namespace
            .clone();
        api.release(&name, &namespace);
        deployment
            .tofu(
                &bundle,
                &stage,
                &environment,
                &[
                    "import",
                    "-input=false",
                    "-no-color",
                    gateway::ADDRESS,
                    &format!("{namespace}/{name}"),
                ],
                &cancel,
            )
            .await
            .expect("fixture release must be read by the actual Helm provider");
        // Import starts without the dependency edges a normal installation
        // records. A native refresh-only apply records those edges without
        // installing or changing the fixture release.
        deployment
            .tofu(
                &bundle,
                &stage,
                &environment,
                &[
                    "apply",
                    "-input=false",
                    "-no-color",
                    "-auto-approve",
                    "-refresh-only",
                    "-target=helm_release.gateway",
                ],
                &cancel,
            )
            .await
            .expect("fixture must record native release dependencies");
        drop(stage);
        drop(store);
        Self {
            api,
            deployment,
            directory,
            name,
            namespace,
        }
    }

    fn objects(&self) -> BTreeMap<String, Value> {
        self.api.objects.0.lock().unwrap().clone()
    }

    async fn bindings(&self) -> BTreeMap<String, (String, String, String, String)> {
        let bundle = Bundle::open(&self.deployment.bundle_directory).unwrap();
        let stage = Store::open(&self.directory.path().join("state/runtime")).unwrap();
        stage
            .bindings(&bundle.tofu(), &CancellationToken::new())
            .await
            .unwrap()
            .into_iter()
            .map(|(address, binding)| {
                (
                    address,
                    (binding.id, binding.spec, binding.namespace, binding.chart),
                )
            })
            .collect()
    }

    async fn finish(&self) {
        *self.api.fault.lock().unwrap() = Fault::Healthy;
        self.deployment
            .destroy(&CancellationToken::new())
            .await
            .expect("retry must create a fresh plan and complete destroy");
        let bindings = self.bindings().await;
        assert_eq!(
            bindings.keys().map(String::as_str).collect::<Vec<_>>(),
            ["nemoclaw_kubernetes_storage.runtime"]
        );
        assert!(
            self.api
                .objects
                .get("v1", "Namespace", "", &self.namespace)
                .is_some()
        );
        assert!(
            self.api
                .objects
                .get(
                    "v1",
                    "Secret",
                    &self.namespace,
                    &format!("{}-kek", self.name)
                )
                .is_some()
        );
        assert!(
            self.api
                .objects
                .get(
                    "v1",
                    "Secret",
                    &self.namespace,
                    &format!("sh.helm.release.v1.{}.v1", self.name)
                )
                .is_none()
        );
        assert!(
            self.api
                .objects
                .get(
                    "v1",
                    "Secret",
                    &self.namespace,
                    &format!("{}-oidc", self.name)
                )
                .is_none()
        );
    }
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn outage_and_permission_failures_before_planning_preserve_release_and_retry() {
    let fixture = Fixture::create().await;
    let initial = fixture.objects();
    let bindings = fixture.bindings().await;
    let mutations = fixture.api.mutations.load(Ordering::Relaxed);
    let state = fixture
        .directory
        .path()
        .join("state/runtime/terraform.tfstate");
    let initial_state = fs::read(&state).unwrap();
    for fault in [Fault::Offline, Fault::Forbidden] {
        *fixture.api.fault.lock().unwrap() = fault;
        assert!(
            fixture
                .deployment
                .destroy(&CancellationToken::new())
                .await
                .is_err(),
            "{fault:?} must stop destroy"
        );
        assert_eq!(
            fixture.bindings().await,
            bindings,
            "failed refresh discarded a release binding"
        );
        assert_eq!(fixture.api.mutations.load(Ordering::Relaxed), mutations);
        assert!(
            fs::read(&state).unwrap() == initial_state,
            "failed plan changed persisted state"
        );
        assert!(
            fixture.objects() == initial,
            "failed observation changed cluster resources"
        );
    }
    assert!(fixture.api.failures.load(Ordering::Relaxed) >= 2);
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn permission_failure_after_saved_plan_restores_release_binding_and_retry() {
    after_plan_failure(Fault::Forbidden).await;
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn api_outage_after_saved_plan_restores_release_binding_and_retry() {
    after_plan_failure(Fault::Offline).await;
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn cancellation_after_successful_apply_retains_a_resumable_destroy_checkpoint() {
    let mut fixture = Fixture::create().await;
    let cancel = CancellationToken::new();
    let late_cancel = cancel.clone();
    fixture.deployment = fixture.deployment.with_progress(Arc::new(move |progress| {
        if matches!(
            progress,
            Progress::Completed {
                operation: "tofu.apply",
                outcome: StepOutcome::Succeeded,
                ..
            }
        ) {
            late_cancel.cancel();
        }
    }));
    let result = fixture.deployment.destroy(&cancel).await;
    assert!(
        cancel.is_cancelled(),
        "fixture did not reach successful native apply"
    );
    assert!(
        matches!(result, Err(Error::Cancelled)),
        "cancellation before checkpoint settlement must leave destroy resumable"
    );
    let state = fixture.directory.path().join("state");
    let store = Store::open(&state).unwrap();
    let record = store.load().unwrap().unwrap();
    assert!(record.destroying());
    assert!(!record.destroyed());
    drop(store);
    let checkpoint = state.join("runtime").join(super::CHECKPOINT);
    assert!(checkpoint.exists());
    let bindings = fixture.bindings().await;
    assert_eq!(
        bindings.keys().map(String::as_str).collect::<Vec<_>>(),
        ["nemoclaw_kubernetes_storage.runtime"]
    );
    let mutations = fixture.api.mutations.load(Ordering::Relaxed);
    fixture.deployment = fixture.deployment.with_progress(Arc::new(|_| {}));
    fixture.finish().await;
    assert_eq!(
        fixture.api.mutations.load(Ordering::Relaxed),
        mutations,
        "recovery must not recreate a release whose absence was confirmed"
    );
    assert!(!checkpoint.exists());
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn an_interrupted_destroy_recovers_on_retry_without_mutating_during_preview() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::create().await;
    let original_bindings = fixture.bindings().await;
    let original_objects = fixture.objects();
    let (bundle, store) = fixture.deployment.open().unwrap();
    let stage = Store::open(&store.directory.join("runtime")).unwrap();
    let mut record = store.load().unwrap().unwrap();
    let bindings = stage
        .bindings(&bundle.tofu(), &CancellationToken::new())
        .await
        .unwrap();
    let graph = compile::compile_teardown(
        &record.document,
        &record.generations,
        &bundle.manifest.version,
        &bindings.keys().cloned().collect(),
        true,
    )
    .unwrap();
    fixture
        .deployment
        .initialize(&bundle, &stage, &graph.graph, &CancellationToken::new())
        .await
        .unwrap();
    let environment = super::super::teardown::destroy_environment(&record.document);
    fixture
        .deployment
        .saved_plan(
            &bundle,
            &stage,
            &environment,
            "destroy.plan",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    record.begin_destroy();
    record.finish_root_destroy();
    store.save(&record).unwrap();
    fixture
        .deployment
        .checkpoint_helm_binding(&bundle, &stage, &record, &CancellationToken::new())
        .await
        .unwrap();
    let checkpoint = stage.directory.join(super::CHECKPOINT);
    assert_eq!(
        fs::metadata(&checkpoint).unwrap().permissions().mode() & 0o077,
        0
    );
    let original_checkpoint = fs::read(&checkpoint).unwrap();
    *fixture.api.fault.lock().unwrap() = Fault::Forbidden;
    // Leave the durable boundary exactly as if the host stopped after the
    // native apply finished and before the SDK's recovery handler ran.
    assert!(
        fixture
            .deployment
            .tofu(
                &bundle,
                &stage,
                &environment,
                &["apply", "-input=false", "-no-color", "destroy.plan"],
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert!(
        !stage
            .bindings(&bundle.tofu(), &CancellationToken::new())
            .await
            .unwrap()
            .contains_key(gateway::ADDRESS),
        "fixture must reproduce the upstream provider's lost binding"
    );
    drop(stage);
    drop(store);
    let incomplete_bindings = fixture.bindings().await;
    let mutations = fixture.api.mutations.load(Ordering::Relaxed);
    assert!(
        fixture
            .deployment
            .plan_destroy(&CancellationToken::new())
            .await
            .is_err(),
        "preview must require an explicit destroy retry to restore state"
    );
    assert_eq!(fixture.bindings().await, incomplete_bindings);
    assert!(fs::read(&checkpoint).unwrap() == original_checkpoint);
    assert_eq!(fixture.api.mutations.load(Ordering::Relaxed), mutations);
    assert!(fixture.objects() == original_objects);
    // With the permission problem still present, retry restores locally then
    // stops at a fresh failed plan; it must not reuse the old saved plan.
    assert!(
        fixture
            .deployment
            .destroy(&CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(fixture.bindings().await, original_bindings);
    assert_eq!(fixture.api.mutations.load(Ordering::Relaxed), mutations);
    assert!(fixture.objects() == original_objects);
    fixture.finish().await;
    assert!(!checkpoint.exists());
}

async fn after_plan_failure(fault: Fault) {
    let mut fixture = Fixture::create().await;
    let initial = fixture.objects();
    let bindings = fixture.bindings().await;
    let mutations = fixture.api.mutations.load(Ordering::Relaxed);
    let arm = fixture.api.fault.clone();
    fixture.deployment = fixture.deployment.with_progress(Arc::new(move |progress| {
        if progress == Progress::Destroying {
            *arm.lock().unwrap() = fault;
        }
    }));
    assert!(
        fixture
            .deployment
            .destroy(&CancellationToken::new())
            .await
            .is_err()
    );
    assert!(
        fixture.api.failures.load(Ordering::Relaxed) > 0,
        "fault did not reach provider after planning"
    );
    assert_eq!(fixture.api.mutations.load(Ordering::Relaxed), mutations);
    assert!(
        fixture.objects() == initial,
        "issuer or release changed after lookup failure"
    );
    assert_eq!(
        fixture.bindings().await,
        bindings,
        "a lookup failure discarded the native Helm release binding"
    );
    fixture.deployment = fixture.deployment.with_progress(Arc::new(|_| {}));
    fixture.finish().await;
}
