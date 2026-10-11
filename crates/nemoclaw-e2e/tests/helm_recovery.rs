// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Helm release recovery during destroy, through the bundled OpenTofu, the
//! Helm provider, and the public `destroy` and `plan_destroy`, against a
//! loopback Kubernetes API that injects outages and permission failures.
//!
//! Installing a release through `apply` would pull the pinned chart, so each
//! test starts from an imported release that the SDK's `test-scenarios`
//! setup builds.

use super::kube_api;
use super::transport;
use base64::{Engine, engine::general_purpose::STANDARD};
use nemoclaw_sdk::{
    CancellationToken, Deployment, Error, ObservationError, Progress, Secrets, StepOutcome,
    config::Document,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

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
    server: transport::Fixture,
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
            server,
        }
    }

    fn release(&self, name: &str, namespace: &str) {
        // Helm accepts its original uncompressed JSON storage format. The
        // release has no workloads: these tests qualify recovery, not a chart.
        let release = json!({
            "name": name, "namespace": namespace, "version":1,
            "info":{"status":"deployed", "description":"recovery fixture",
                "first_deployed":"2026-01-01T00:00:00Z", "last_deployed":"2026-01-01T00:00:00Z"},
            "chart":{"metadata":{"name":nemoclaw_sdk::kubernetes::gateway::CHART, "version":"0.0.115", "apiVersion":"v2"}},
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
    fn resolve(&self, name: &str) -> Result<String, ObservationError> {
        assert_eq!(
            name, "TEST_KUBECONFIG",
            "teardown requested an unrelated credential"
        );
        Ok(self.0.clone())
    }
}

/// The SDK's local configuration on a managed Kubernetes gateway.
fn document() -> Document {
    let original = Document::parse(
        include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_slice(),
    )
    .unwrap();
    let mut value = serde_json::to_value(original).unwrap();
    value["spec"]["gateway"] = json!({
        "management":"managed", "runtime":{"provider":"kubernetes"}, "endpoint":"https://127.0.0.1:17671",
        "kubernetes": {
            "kubeconfig":{"env":"TEST_KUBECONFIG"}, "context":"test-cluster", "namespace":"test-agents",
            "authentication":{"profile":"development"}
        }
    });
    value["spec"]["sandboxes"][0]["image"]["metadata"] = json!({"env":"TEST_IMAGE_METADATA"});
    Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
}

/// Managed resources in a stage's OpenTofu state, by address.
fn bindings(stage: &Path) -> BTreeMap<String, Value> {
    let state: Value =
        serde_json::from_slice(&fs::read(stage.join("terraform.tfstate")).unwrap()).unwrap();
    state["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|resource| resource["mode"] == "managed")
        .map(|resource| {
            (
                format!(
                    "{}.{}",
                    resource["type"].as_str().unwrap(),
                    resource["name"].as_str().unwrap()
                ),
                resource["instances"][0]["attributes"].clone(),
            )
        })
        .collect()
}

/// The file names in a directory.
fn files(directory: &Path) -> BTreeSet<String> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

/// Files the SDK added to a stage since `before`, other than OpenTofu's saved
/// plans and state backups: the recovery checkpoint while one exists.
fn recovery_files(stage: &Path, before: &BTreeSet<String>) -> Vec<String> {
    files(stage)
        .difference(before)
        .filter(|name| !name.ends_with(".plan") && !name.ends_with(".backup"))
        .cloned()
        .collect()
}

struct Fixture {
    api: Api,
    deployment: Deployment,
    bundle: PathBuf,
    kubeconfig: PathBuf,
    directory: tempfile::TempDir,
    name: String,
    namespace: String,
}

impl Fixture {
    /// A runtime apply that stopped after the Helm provider recorded the
    /// gateway release, built through the bundled providers.
    async fn create() -> Self {
        let bundle = PathBuf::from(
            std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("explicit verified bundle"),
        );
        let api = Api::start().await;
        let directory = tempfile::tempdir().unwrap();
        let kubeconfig = directory.path().join("fixture.kubeconfig");
        fs::write(&kubeconfig, serde_json::to_vec(&json!({
            "apiVersion":"v1", "kind":"Config", "current-context":"test-cluster",
            "clusters":[{"name":"fixture", "cluster":{"server":api.server.endpoint}}],
            "contexts":[{"name":"test-cluster", "context":{"cluster":"fixture", "user":"fixture"}}],
            "users":[{"name":"fixture", "user":{}}]
        })).unwrap()).unwrap();
        let document = document();
        let name = format!("{}-gateway", document.workspace());
        let namespace = document
            .spec
            .gateway
            .as_kubernetes()
            .unwrap()
            .namespace
            .clone();
        api.release(&name, &namespace);
        let deployment = Deployment::new(&directory.path().join("state"), &bundle).with_secrets(
            Arc::new(Kubeconfig(kubeconfig.to_string_lossy().into_owned())),
        );
        let fixture = Self {
            api,
            deployment,
            bundle,
            kubeconfig,
            directory,
            name,
            namespace,
        };
        fixture
            .deployment
            .scenario_interrupt_runtime_apply(&document)
            .unwrap();
        let release = format!("{}/{}", fixture.namespace, fixture.name);
        fixture
            .deployment
            .scenario_runtime_tofu(
                &[
                    &[
                        "apply",
                        "-input=false",
                        "-no-color",
                        "-auto-approve",
                        "-target=nemoclaw_kubernetes_auth.runtime",
                    ],
                    &[
                        "import",
                        "-input=false",
                        "-no-color",
                        "helm_release.gateway",
                        &release,
                    ],
                    // Import starts without the dependency edges a normal
                    // installation records. A refresh-only apply records them
                    // without installing or changing the fixture release.
                    &[
                        "apply",
                        "-input=false",
                        "-no-color",
                        "-auto-approve",
                        "-refresh-only",
                        "-target=helm_release.gateway",
                    ],
                ],
                &CancellationToken::new(),
            )
            .await
            .expect("the bundled providers must read the fixture release");
        fixture
    }

    fn deployment(&self) -> Deployment {
        Deployment::new(&self.directory.path().join("state"), &self.bundle).with_secrets(Arc::new(
            Kubeconfig(self.kubeconfig.to_string_lossy().into_owned()),
        ))
    }

    fn stage(&self) -> PathBuf {
        self.directory.path().join("state/runtime")
    }

    fn objects(&self) -> BTreeMap<String, Value> {
        self.api.objects.0.lock().unwrap().clone()
    }

    fn bindings(&self) -> BTreeMap<String, Value> {
        bindings(&self.stage())
    }

    async fn finish(&self) {
        *self.api.fault.lock().unwrap() = Fault::Healthy;
        self.deployment()
            .destroy(&CancellationToken::new())
            .await
            .expect("retry must create a fresh plan and complete destroy");
        assert_eq!(
            self.bindings()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["nemoclaw_kubernetes_storage.runtime"]
        );
        let objects = &self.api.objects;
        assert!(
            objects
                .get("v1", "Namespace", "", &self.namespace)
                .is_some()
        );
        let secret = |name: String| objects.get("v1", "Secret", &self.namespace, &name);
        assert!(secret(format!("{}-kek", self.name)).is_some());
        assert!(secret(format!("sh.helm.release.v1.{}.v1", self.name)).is_none());
        assert!(secret(format!("{}-oidc", self.name)).is_none());
    }
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn outage_and_permission_failures_before_planning_preserve_release_and_retry() {
    let fixture = Fixture::create().await;
    let initial = fixture.objects();
    let bindings = fixture.bindings();
    let mutations = fixture.api.mutations.load(Ordering::Relaxed);
    let state = fixture.stage().join("terraform.tfstate");
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
            fixture.bindings(),
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

async fn after_plan_failure(fault: Fault) {
    let fixture = Fixture::create().await;
    let initial = fixture.objects();
    let bindings = fixture.bindings();
    let mutations = fixture.api.mutations.load(Ordering::Relaxed);
    let arm = fixture.api.fault.clone();
    let deployment = fixture
        .deployment()
        .with_progress(Arc::new(move |progress| {
            if progress == Progress::Destroying {
                *arm.lock().unwrap() = fault;
            }
        }));
    assert!(deployment.destroy(&CancellationToken::new()).await.is_err());
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
        fixture.bindings(),
        bindings,
        "a lookup failure discarded the native Helm release binding"
    );
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn cancellation_after_successful_apply_retains_a_resumable_destroy_checkpoint() {
    let fixture = Fixture::create().await;
    let before = files(&fixture.stage());
    let cancel = CancellationToken::new();
    let late_cancel = cancel.clone();
    let deployment = fixture
        .deployment()
        .with_progress(Arc::new(move |progress| {
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
    let result = deployment.destroy(&cancel).await;
    assert!(
        cancel.is_cancelled(),
        "fixture did not reach successful native apply"
    );
    assert!(
        matches!(result, Err(Error::Cancelled)),
        "cancellation before checkpoint settlement must leave destroy resumable"
    );
    let refusal = fixture
        .deployment
        .export(&CancellationToken::new())
        .await
        .unwrap_err()
        .to_string();
    assert!(
        refusal.contains("cannot export while destroy is unfinished"),
        "{refusal}"
    );
    assert!(
        !recovery_files(&fixture.stage(), &before).is_empty(),
        "cancelled destroy keeps its recovery checkpoint"
    );
    assert_eq!(
        fixture
            .bindings()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["nemoclaw_kubernetes_storage.runtime"]
    );
    let mutations = fixture.api.mutations.load(Ordering::Relaxed);
    fixture.finish().await;
    assert_eq!(
        fixture.api.mutations.load(Ordering::Relaxed),
        mutations,
        "recovery must not recreate a release whose absence was confirmed"
    );
    assert!(
        recovery_files(&fixture.stage(), &before).is_empty(),
        "destroy removes its recovery checkpoint"
    );
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn an_interrupted_destroy_recovers_on_retry_without_mutating_during_preview() {
    let fixture = Fixture::create().await;
    let original_bindings = fixture.bindings();
    let original_objects = fixture.objects();
    let before = files(&fixture.stage());
    // Lose Helm's release lookup after the saved plan, and stop as if the host
    // exited after the native apply and before the SDK's recovery ran.
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let arm = fixture.api.fault.clone();
    let deployment = fixture
        .deployment()
        .with_progress(Arc::new(move |progress| match progress {
            Progress::Destroying => *arm.lock().unwrap() = Fault::Forbidden,
            Progress::Completed {
                operation: "tofu.apply",
                ..
            } => stop.cancel(),
            _ => {}
        }));
    assert!(matches!(
        deployment.destroy(&cancel).await,
        Err(Error::Cancelled)
    ));
    assert!(
        !fixture.bindings().contains_key("helm_release.gateway"),
        "fixture must reproduce the upstream provider's lost binding"
    );
    assert!(
        !recovery_files(&fixture.stage(), &before).is_empty(),
        "the interrupted destroy keeps its recovery checkpoint"
    );
    let snapshot = |directory: &Path| -> BTreeMap<String, Vec<u8>> {
        files(directory)
            .into_iter()
            // Preview regenerates the OpenTofu configuration; it is not state.
            .filter(|name| name != "main.tf.json" && directory.join(name).is_file())
            .map(|name| {
                let bytes = fs::read(directory.join(&name)).unwrap();
                (name, bytes)
            })
            .collect()
    };
    let interrupted = snapshot(&fixture.stage());
    let mutations = fixture.api.mutations.load(Ordering::Relaxed);
    assert!(
        fixture
            .deployment
            .plan_destroy(&CancellationToken::new())
            .await
            .is_err(),
        "preview must require an explicit destroy retry to restore state"
    );
    assert!(
        snapshot(&fixture.stage()) == interrupted,
        "preview changed the stage's state or recovery checkpoint"
    );
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
    assert_eq!(fixture.bindings(), original_bindings);
    assert_eq!(fixture.api.mutations.load(Ordering::Relaxed), mutations);
    assert!(fixture.objects() == original_objects);
    fixture.finish().await;
    assert!(
        recovery_files(&fixture.stage(), &before).is_empty(),
        "destroy removes its recovery checkpoint"
    );
}
