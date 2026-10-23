// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Exercise the compiled Kubernetes runtime graph with the bundled OpenTofu
//! and providers, with no Helm executable on PATH. Requires an owned cluster
//! with Agent Sandbox, its explicit kubeconfig/context, and a verified bundle.

#[path = "kubernetes_oidc.rs"]
mod oidc;
#[path = "kubernetes_registry.rs"]
mod registry;
#[path = "kubernetes_requests.rs"]
mod requests;

use k8s_openapi::api::{
    apps::v1::StatefulSet,
    core::v1::{Namespace, PersistentVolumeClaim, Secret},
};
use kube::{
    Api,
    api::{DynamicObject, ListParams},
};
use nemoclaw_e2e::{
    assert_same_deployment_state,
    state::{agent_sandbox_id, runtime_id, sandbox_binding},
};
use nemoclaw_sdk::{
    ObservationError,
    bundle::Bundle,
    compile::{Generations, compile_runtime, compile_teardown, runtime_targets},
    config::{ComputeDriver, Document, ExternalGateway, FileRef, Gateway, SecretRef, TLS},
    kubernetes::{
        CA_ENV, CERT_ENV, ClusterTarget, GATEWAY_KIND, KEY_ENV, STATE_ENV, STORAGE_KIND, Spec,
        TOKEN_ENV, connect, operations::Operations, server,
    },
};
use openshell_provider::{OpenShell, Secrets};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Output,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

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
        .unwrap_or_else(|_| panic!("{name} is required; see docs/contributing/live-tests.md"))
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).unwrap();
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Create a ConfigMap, Secret, Service or Deployment from its manifest, for a
/// server that a test runs in its own namespace, as a platform would.
async fn create(client: &kube::Client, object: Value) {
    use k8s_openapi::api::{
        apps::v1::Deployment,
        core::v1::{ConfigMap, Service},
    };
    use kube::api::PostParams;
    let namespace = object["metadata"]["namespace"].as_str().unwrap().to_owned();
    let post = PostParams::default();
    match object["kind"].as_str().unwrap() {
        "ConfigMap" => {
            Api::<ConfigMap>::namespaced(client.clone(), &namespace)
                .create(&post, &serde_json::from_value(object).unwrap())
                .await
                .unwrap();
        }
        "Secret" => {
            Api::<Secret>::namespaced(client.clone(), &namespace)
                .create(&post, &serde_json::from_value(object).unwrap())
                .await
                .unwrap();
        }
        "Service" => {
            Api::<Service>::namespaced(client.clone(), &namespace)
                .create(&post, &serde_json::from_value(object).unwrap())
                .await
                .unwrap();
        }
        "Deployment" => {
            Api::<Deployment>::namespaced(client.clone(), &namespace)
                .create(&post, &serde_json::from_value(object).unwrap())
                .await
                .unwrap();
        }
        other => panic!("unexpected object {other}"),
    }
}

/// State, generated credentials and plans stay in a private directory, including
/// after failure. No OpenTofu output is copied to the test log.
struct Tofu {
    bundle: Bundle,
    directory: PathBuf,
    target: ClusterTarget,
    invocation: AtomicUsize,
}

impl Tofu {
    fn new(bundle: Bundle, target: ClusterTarget) -> Self {
        let directory = tempfile::Builder::new()
            .prefix("nemoclaw-kubernetes-live-")
            .tempdir()
            .unwrap()
            .keep();
        for child in ["runtime", "home", "empty-path", "diagnostics"] {
            fs::create_dir(directory.join(child)).unwrap();
        }
        let mirror = bundle.directory.join("providers");
        let mirror = serde_json::to_string(&mirror.to_string_lossy().replace('\\', "/")).unwrap();
        fs::write(
            directory.join("runtime/providers.tfrc"),
            format!("provider_installation {{ filesystem_mirror {{ path = {mirror} }} }}\n"),
        )
        .unwrap();
        eprintln!(
            "Private Kubernetes test state retained at {}",
            directory.display()
        );
        Self {
            bundle,
            directory,
            target,
            invocation: AtomicUsize::new(0),
        }
    }

    fn graph(&self, graph: &Value) {
        fs::write(
            self.directory.join("runtime/main.tf.json"),
            serde_json::to_vec(graph).unwrap(),
        )
        .unwrap();
    }

    async fn run(&self, arguments: &[&str]) -> Output {
        let mut command = tokio::process::Command::new(self.bundle.tofu());
        command
            .args(arguments)
            .current_dir(self.directory.join("runtime"))
            .env_clear()
            .env("PATH", self.directory.join("empty-path"))
            .env("HOME", self.directory.join("home"))
            .env("TF_IN_AUTOMATION", "1")
            .env("TF_INPUT", "0")
            .env("CHECKPOINT_DISABLE", "1")
            .env(
                "TF_CLI_CONFIG_FILE",
                self.directory.join("runtime/providers.tfrc"),
            )
            .env("NEMOCLAW_TEST_KUBECONFIG", &self.target.kubeconfig)
            .env("TF_VAR_nemoclaw_kubeconfig", &self.target.kubeconfig)
            .env(STATE_ENV, self.directory.join("kubernetes"))
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(900), command.output())
            .await
            .expect("OpenTofu timed out; private state and cluster resources retained")
            .expect("cannot execute the verified bundle's OpenTofu");
        let invocation = self.invocation.fetch_add(1, Ordering::Relaxed);
        for (stream, bytes) in [("stdout", &output.stdout), ("stderr", &output.stderr)] {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(
                    self.directory
                        .join("diagnostics")
                        .join(format!("{invocation:03}-{}.{stream}", arguments[0],)),
                )
                .expect("cannot create a private OpenTofu diagnostic file")
                .write_all(bytes)
                .expect("cannot retain private OpenTofu diagnostics");
        }
        output
    }

    async fn success(&self, arguments: &[&str]) -> Vec<u8> {
        let output = self.run(arguments).await;
        assert!(
            output.status.success(),
            "OpenTofu {} failed (status {:?}); output suppressed; private state and resources retained",
            arguments[0],
            output.status.code(),
        );
        output.stdout
    }

    async fn plan(&self, expected: &BTreeMap<String, Vec<String>>) {
        let output = self
            .run(&[
                "plan",
                "-input=false",
                "-no-color",
                "-detailed-exitcode",
                "-out=operation.tfplan",
            ])
            .await;
        assert_eq!(
            output.status.code(),
            Some(if expected.is_empty() { 0 } else { 2 }),
            "unexpected OpenTofu plan result; output suppressed; state and resources retained",
        );
        let bytes = self.success(&["show", "-json", "operation.tfplan"]).await;
        let plan: Value = serde_json::from_slice(&bytes).expect("invalid OpenTofu plan JSON");
        let changes: BTreeMap<String, Vec<String>> = plan["resource_changes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|resource| {
                let actions: Vec<String> = resource["change"]["actions"]
                    .as_array()
                    .expect("missing plan actions")
                    .iter()
                    .map(|action| action.as_str().unwrap().into())
                    .collect();
                (actions != ["no-op"])
                    .then(|| (resource["address"].as_str().unwrap().to_owned(), actions))
            })
            .collect();
        // Addresses and action names are safe to report; resource values are not.
        assert_eq!(&changes, expected, "unexpected resource actions");
    }

    async fn apply(&self) {
        self.success(&["apply", "-input=false", "-no-color", "operation.tfplan"])
            .await;
    }

    async fn addresses(&self) -> BTreeSet<String> {
        let bytes = self.success(&["show", "-json"]).await;
        let state: Value = serde_json::from_slice(&bytes).expect("invalid OpenTofu state JSON");
        state["values"]["root_module"]["resources"]
            .as_array()
            .expect("missing root resources")
            .iter()
            .map(|resource| resource["address"].as_str().unwrap().to_owned())
            .collect()
    }
}

fn actions(addresses: &[&str], action: &str) -> BTreeMap<String, Vec<String>> {
    addresses
        .iter()
        .map(|address| ((*address).into(), vec![action.into()]))
        .collect()
}

#[derive(PartialEq, Eq)]
struct Retained {
    namespace_uid: String,
    key_uid: String,
    key_digest: Vec<u8>,
    claims: BTreeMap<String, String>,
}

/// Only the chart's claims count: the StatefulSet controller labels them with
/// the release's selector, while an agent sandbox's workspace claim in the
/// same namespace, which destroy deletes, carries only Agent Sandbox labels.
/// A namespace or claim that is being deleted is not retained, although its
/// finalizers keep it readable with the same UID for a while. Errors do not
/// panic, so a caller can still clean up; each names the failed check
/// without cluster values.
async fn retained(
    client: &kube::Client,
    namespace: &str,
    release: &str,
) -> Result<Retained, &'static str> {
    let observed = Api::<Namespace>::all(client.clone())
        .get(namespace)
        .await
        .map_err(|_| "cannot observe the retained namespace")?
        .metadata;
    if observed.deletion_timestamp.is_some() {
        return Err("the retained namespace is being deleted");
    }
    let namespace_uid = observed.uid.ok_or("the retained namespace has no UID")?;
    let key = Api::<Secret>::namespaced(client.clone(), namespace)
        .get(&format!("{release}-kek"))
        .await
        .map_err(|_| "cannot observe the retained encryption key")?;
    let key_digest = key
        .data
        .as_ref()
        .and_then(|data| data.get("key-encryption-key"))
        .map(|bytes| Sha256::digest(&bytes.0).to_vec())
        .ok_or("the retained encryption key has no key data")?;
    let claims = Api::<PersistentVolumeClaim>::namespaced(client.clone(), namespace)
        .list(&ListParams::default().labels(&format!("app.kubernetes.io/instance={release}")))
        .await
        .map_err(|_| "cannot observe the gateway's persistent volume claims")?
        .items;
    if claims.is_empty() {
        return Err("no gateway persistent volume claim exists");
    }
    if claims
        .iter()
        .any(|claim| claim.metadata.deletion_timestamp.is_some())
    {
        return Err("a gateway persistent volume claim is being deleted");
    }
    if !claims.iter().all(|claim| {
        claim
            .status
            .as_ref()
            .and_then(|status| status.phase.as_deref())
            == Some("Bound")
    }) {
        return Err("a gateway persistent volume claim is not bound");
    }
    Ok(Retained {
        namespace_uid,
        key_uid: key
            .metadata
            .uid
            .ok_or("the retained encryption key has no UID")?,
        key_digest,
        claims: claims
            .into_iter()
            .map(|claim| claim.metadata.name.zip(claim.metadata.uid))
            .collect::<Option<_>>()
            .ok_or("a gateway persistent volume claim has no name or UID")?,
    })
}

async fn release_count(client: &kube::Client, namespace: &str, release: &str) -> usize {
    Api::<Secret>::namespaced(client.clone(), namespace)
        .list(&ListParams::default().labels(&format!("owner=helm,name={release}")))
        .await
        .unwrap_or_else(|_| panic!("cannot observe native Helm release records"))
        .items
        .len()
}

/// A client of a managed gateway through `connection`'s port-forward, with
/// the token and TLS files in `environment`.
fn gateway_client(
    connection: &nemoclaw_sdk::kubernetes::Connection,
    environment: BTreeMap<String, String>,
) -> Result<OpenShell, ObservationError> {
    let file = |env: &str| FileRef { env: env.into() };
    let gateway = Gateway::External(ExternalGateway {
        endpoint: connection.endpoint().to_owned(),
        credential: Some(SecretRef {
            env: TOKEN_ENV.into(),
        }),
        tls: Some(TLS {
            ca: file(CA_ENV),
            certificate: file(CERT_ENV),
            key: file(KEY_ENV),
        }),
        ..Default::default()
    });
    OpenShell::connect(&gateway.connection(), Arc::new(Values(environment)))
}

async fn authenticated_gateway(operations: &Operations, spec: &Spec) {
    let connection = operations.connect(spec).await.unwrap();
    let client = gateway_client(&connection, connection.environment()).unwrap();
    client
        .verify_gateway(ComputeDriver::Kubernetes)
        .await
        .expect("GetGatewayInfo accepts the development token over mutual TLS");

    let other = tempfile::tempdir().unwrap();
    let foreign = nemoclaw_sdk::kubernetes::auth::Development::new(
        other.path().join("auth"),
        &spec.name,
        &spec.settings.kubernetes.as_ref().unwrap().namespace,
        &spec.owner,
    )
    .ensure()
    .unwrap()
    .token(time::OffsetDateTime::now_utc().unix_timestamp());
    let mut forged = connection.environment();
    forged.insert(TOKEN_ENV.into(), foreign);
    let client = gateway_client(&connection, forged).unwrap();
    assert!(
        matches!(
            client.gateway_capabilities().await,
            Err(ObservationError::Authentication | ObservationError::Permission)
        ),
        "GetGatewayInfo refuses a token signed by an unknown issuer key",
    );
}

#[tokio::test]
#[ignore = "needs an owned cluster with Agent Sandbox and a verified bundle; see live-tests.md"]
async fn the_gateway_installs_authenticates_and_is_removed_keeping_storage() {
    let bundle = Bundle::open(Path::new(&required("NEMOCLAW_TEST_BUNDLE"))).unwrap();
    let target = ClusterTarget {
        kubeconfig: PathBuf::from(required("NEMOCLAW_TEST_KUBECONFIG"))
            .canonicalize()
            .unwrap(),
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
    let namespace = format!("nc-live-{}", &hex[..16]);
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let original = Document::parse(
        include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_slice(),
    )
    .unwrap();
    let mut value = serde_json::to_value(original).unwrap();
    value["metadata"]["uid"] = json!(owner);
    value["spec"]["gateway"] = json!({
        "management": "managed", "runtime": {"provider": "kubernetes"},
        "endpoint": format!("https://127.0.0.1:{port}"),
        "kubernetes": {
            "kubeconfig": {"env": "NEMOCLAW_TEST_KUBECONFIG"},
            "context": target.context, "namespace": namespace,
            "authentication": {"profile": "development"}
        }
    });
    value["spec"]["sandboxes"][0]["image"]["metadata"] = json!({"env": "TEST_IMAGE_METADATA"});
    let document = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        STORAGE_KIND,
        GATEWAY_KIND,
    ]
    .map(|kind| (kind.into(), hex.clone()))
    .into();
    let graph = compile_runtime(&document, &generations, &bundle.manifest.version).unwrap();
    let spec = runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == GATEWAY_KIND)
        .map(|target| Spec::from_row(&target.kind, &target.values).unwrap())
        .unwrap();
    let tofu = Tofu::new(bundle, target);
    // These private files make a failed run inspectable without logging the
    // kubeconfig or the generated TLS, signing, and encryption material.
    fs::write(
        tofu.directory.join("document.json"),
        serde_json::to_vec(&document).unwrap(),
    )
    .unwrap();
    fs::write(
        tofu.directory.join("generations.json"),
        serde_json::to_vec(&generations).unwrap(),
    )
    .unwrap();
    let operations = Operations {
        server: server(&tofu.target).unwrap(),
        client: connect(&tofu.target).await.unwrap(),
        state: tofu.directory.join("kubernetes"),
        openshift_wait: nemoclaw_sdk::kubernetes::operations::OPENSHIFT_WAIT,
    };
    let all = [
        "openshell_kubernetes_storage.runtime",
        "openshell_kubernetes_auth.runtime",
        "helm_release.gateway",
        "openshell_kubernetes_gateway.runtime",
    ];
    let workloads = &all[1..];
    let storage = BTreeSet::from([all[0].to_owned()]);
    let namespaces = Api::<Namespace>::all(operations.client.clone());
    assert!(
        namespaces
            .get_opt(&namespace)
            .await
            .unwrap_or_else(|_| panic!("cannot observe the test namespace before planning"))
            .is_none(),
        "the generated test namespace must be absent",
    );
    tofu.graph(&graph);
    tofu.success(&["init", "-input=false", "-no-color"]).await;
    tofu.plan(&actions(&all, "create")).await;
    assert!(
        namespaces
            .get_opt(&namespace)
            .await
            .unwrap_or_else(|_| panic!("cannot observe the test namespace after planning"))
            .is_none(),
        "planning must not create the namespace",
    );
    tofu.apply().await;
    assert_eq!(tofu.addresses().await, all.map(str::to_owned).into());
    tofu.plan(&BTreeMap::new()).await;
    let kept = retained(&operations.client, &namespace, &spec.name)
        .await
        .unwrap();

    for cycle in 0..2 {
        assert_eq!(
            release_count(&operations.client, &namespace, &spec.name).await,
            1,
            "native Helm tracks one deployed release"
        );
        authenticated_gateway(&operations, &spec).await;
        let teardown = compile_teardown(
            &document,
            &generations,
            &tofu.bundle.manifest.version,
            &tofu.addresses().await,
        )
        .unwrap();
        assert_eq!(teardown.retained, storage);
        // The teardown graph comes from the deployment's whole graph, so it
        // can require more providers than the runtime graph; the SDK
        // initializes before every plan, and so does this test.
        tofu.graph(&teardown.graph);
        tofu.success(&["init", "-input=false", "-no-color"]).await;
        tofu.plan(&actions(workloads, "delete")).await;
        tofu.apply().await;
        assert_eq!(tofu.addresses().await, storage);
        assert_eq!(
            release_count(&operations.client, &namespace, &spec.name).await,
            0,
            "native Helm removed its release record"
        );
        assert!(
            Api::<StatefulSet>::namespaced(operations.client.clone(), &namespace)
                .get_opt(&spec.name)
                .await
                .unwrap_or_else(|_| panic!("cannot observe the removed gateway"))
                .is_none(),
            "the gateway StatefulSet is gone"
        );
        assert!(
            kept == retained(&operations.client, &namespace, &spec.name)
                .await
                .unwrap(),
            "namespace, encryption key and PVC identities survive removal"
        );
        if cycle == 0 {
            tofu.graph(&graph);
            tofu.success(&["init", "-input=false", "-no-color"]).await;
            tofu.plan(&actions(workloads, "create")).await;
            tofu.apply().await;
            tofu.plan(&BTreeMap::new()).await;
            assert!(
                kept == retained(&operations.client, &namespace, &spec.name)
                    .await
                    .unwrap(),
                "reapply reuses retained storage and encryption key"
            );
        }
    }
    // Removing what destroy retains: deleting the namespace removes the key
    // and claims, and with kind's Delete reclaim policy, their volumes.
    let volumes: Vec<String> =
        Api::<PersistentVolumeClaim>::namespaced(operations.client.clone(), &namespace)
            .list(&ListParams::default())
            .await
            .unwrap()
            .items
            .into_iter()
            .filter_map(|claim| claim.spec.and_then(|spec| spec.volume_name))
            .collect();
    assert!(
        !volumes.is_empty(),
        "the gateway's claims are bound to volumes"
    );
    let namespaces = Api::<Namespace>::all(operations.client.clone());
    namespaces
        .delete(&namespace, &kube::api::DeleteParams::foreground())
        .await
        .unwrap();
    let persistent =
        Api::<k8s_openapi::api::core::v1::PersistentVolume>::all(operations.client.clone());
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        let namespace_gone = namespaces.get_opt(&namespace).await.unwrap().is_none();
        let mut volumes_gone = true;
        for volume in &volumes {
            volumes_gone &= persistent.get_opt(volume).await.unwrap().is_none();
        }
        if namespace_gone && volumes_gone {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "deleting the namespace removes the deployment's retained resources"
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// What the deployment's namespace shows when apply fails: each pod's phase
/// and container states, recent events, and the end of each container's log.
/// Live failures otherwise leave only the SDK's summary in CI logs.
async fn namespace_diagnostics(client: &kube::Client, namespace: &str) -> String {
    use k8s_openapi::api::core::v1::{Event, Pod};
    use kube::api::LogParams;
    let mut out = format!("diagnostics for namespace {namespace}:\n");
    let pods = Api::<Pod>::namespaced(client.clone(), namespace);
    match pods.list(&ListParams::default()).await {
        Ok(list) => {
            for pod in list.items {
                let name = pod.metadata.name.clone().unwrap_or_default();
                let status = pod.status.clone().unwrap_or_default();
                out += &format!("pod {name}: {}\n", status.phase.unwrap_or_default());
                for container in status.container_statuses.unwrap_or_default() {
                    let state = container.state.as_ref().map(|state| {
                        if let Some(waiting) = &state.waiting {
                            format!(
                                "waiting {} {}",
                                waiting.reason.clone().unwrap_or_default(),
                                waiting.message.clone().unwrap_or_default()
                            )
                        } else if let Some(done) = &state.terminated {
                            format!(
                                "terminated {} exit {}",
                                done.reason.clone().unwrap_or_default(),
                                done.exit_code
                            )
                        } else {
                            "running".into()
                        }
                    });
                    out += &format!(
                        "  container {}: ready={} restarts={} {}\n",
                        container.name,
                        container.ready,
                        container.restart_count,
                        state.unwrap_or_default()
                    );
                    let params = LogParams {
                        container: Some(container.name.clone()),
                        tail_lines: Some(40),
                        ..LogParams::default()
                    };
                    if let Ok(log) = pods.logs(&name, &params).await {
                        for line in log.lines() {
                            out += &format!("    | {line}\n");
                        }
                    }
                }
            }
        }
        Err(error) => out += &format!("cannot list pods: {error}\n"),
    }
    if let Ok(list) = Api::<Event>::namespaced(client.clone(), namespace)
        .list(&ListParams::default())
        .await
    {
        let mut events = list.items;
        events.sort_by_key(|event| event.last_timestamp.clone().map(|time| time.0));
        for event in events.iter().rev().take(15).rev() {
            out += &format!(
                "event {} {}: {}\n",
                event.reason.clone().unwrap_or_default(),
                event.involved_object.name.clone().unwrap_or_default(),
                event
                    .message
                    .clone()
                    .unwrap_or_default()
                    .chars()
                    .take(240)
                    .collect::<String>()
            );
        }
    }
    out
}

/// Print the namespace's diagnostics if `applied` failed, while its pods still
/// exist; the caller asserts the result.
async fn diagnosed<T, E>(
    applied: Result<T, E>,
    client: &kube::Client,
    namespace: &str,
) -> Result<T, E> {
    if applied.is_err() {
        eprintln!("{}", namespace_diagnostics(client, namespace).await);
    }
    applied
}

/// What OpenTofu state records about one sandbox and its agent.
#[derive(Debug, PartialEq)]
struct Identity {
    /// The sandbox's ID.
    sandbox: String,
    /// The ID of the sandbox the agent is bound to.
    agent_sandbox: String,
    /// The agent's Fabric runtime ID.
    runtime: String,
}

/// Each sandbox's identity, by sandbox name, from the deployment's OpenTofu
/// state. The readers panic on a missing record; the panic is returned so the
/// caller can destroy before raising it.
fn identities(
    directory: &Path,
    document: &Document,
) -> std::thread::Result<BTreeMap<String, Identity>> {
    std::panic::catch_unwind(|| {
        document
            .spec
            .sandboxes
            .iter()
            .map(|sandbox| {
                let identity = Identity {
                    sandbox: sandbox_binding(directory, &sandbox.name)["id"].clone(),
                    agent_sandbox: agent_sandbox_id(directory, &sandbox.name),
                    runtime: runtime_id(directory, &sandbox.name),
                };
                (sandbox.name.clone(), identity)
            })
            .collect()
    })
}

/// The names of the Agent Sandbox `Sandbox` objects in `namespace`, read in
/// the version the cluster serves.
async fn sandbox_objects(client: &kube::Client, namespace: &str) -> kube::Result<BTreeSet<String>> {
    use kube::error::{DiscoveryError, Error};
    // A missing kind is returned, not raised, so the caller still destroys.
    let (resource, _) = kube::discovery::group(client, "agents.x-k8s.io")
        .await?
        .recommended_kind("Sandbox")
        .ok_or_else(|| Error::Discovery(DiscoveryError::MissingKind("Sandbox".into())))?;
    Ok(
        Api::<DynamicObject>::namespaced_with(client.clone(), namespace, &resource)
            .list(&ListParams::default())
            .await?
            .items
            .into_iter()
            .filter_map(|object| object.metadata.name)
            .collect(),
    )
}

/// The `Sandbox` objects left in `namespace` once none remain or 60 s pass,
/// as their deletion can finish after destroy returns.
async fn sandbox_objects_left(
    client: &kube::Client,
    namespace: &str,
) -> kube::Result<BTreeSet<String>> {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let left = sandbox_objects(client, namespace).await;
        if left.as_ref().is_ok_and(BTreeSet::is_empty) || std::time::Instant::now() >= deadline {
            return left;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// The document `deploy_image_and_export` applies: a managed gateway on
/// `provider` at a free loopback port, and one sandbox per `(sandbox, agent)`
/// name pair running `image`'s agent, all sharing one inference profile with
/// the keyless model server at `endpoint`. Each sandbox also grants an
/// endpoint named for it, so no two sandboxes have the same policy.
fn agent_document(
    provider: &str,
    uid: &str,
    namespace: &str,
    image: &str,
    pull_secrets: &[&str],
    sandboxes: &[(&str, &str)],
    endpoint: &str,
) -> Document {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let harness = required("NEMOCLAW_TEST_AGENT_HARNESS");
    let sandboxes: String = sandboxes
        .iter()
        .map(|(sandbox, agent)| {
            format!(
                "
    - name: {sandbox}
      image:
        ref: {image}
        metadata: {{env: NEMOCLAW_TEST_AGENT_METADATA}}
      network:
        tier: isolated
        grants:
          {sandbox}:
            endpoints:
              - host: {sandbox}.example.test
                port: 443
      harness:
        kind: {harness}
      agent:
        name: {agent}
        inferenceRef: chat"
            )
        })
        .collect();
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
      provider: {provider}
    endpoint: https://127.0.0.1:{port}
    kubernetes:
      kubeconfig: {{env: NEMOCLAW_TEST_KUBECONFIG}}
      context: {context}
      namespace: {namespace}
      authentication: {{profile: development}}
      imagePullSecrets: {pull_secrets}
  inferenceProviders:
    - name: stub
      provider: openai
      endpoint: {endpoint}
  inferences:
    chat:
      routes:
        - name: primary
          providerRef: stub
          overrides:
            model: fixture-model
            maxTokens: 2048{extensions}
  sandboxes:{sandboxes}
",
        context = required("NEMOCLAW_TEST_KUBE_CONTEXT"),
        pull_secrets = serde_json::to_string(pull_secrets).unwrap(),
        // Pi needs a context window and input types for a model it does not
        // ship, as examples/fabric-pi.yaml declares; without `input`, Pi fails
        // every request. OpenClaw declares no model extensions.
        extensions = if harness == "nvidia.fabric.pi" {
            "\n            extensions:\n              context_window: 8192\n              input: [\"text\"]"
        } else {
            ""
        },
    );
    Document::parse(yaml.as_bytes()).unwrap()
}

/// The one sandbox, and its agent, that a deployment has unless a test needs more.
const ONE_AGENT: [(&str, &str); 1] = [("assistant", "main")];

/// A full deployment on a real cluster through the public SDK: the managed
/// gateway, then one agent sandbox per `(sandbox, agent)` name pair, each from
/// an image built from this checkout and sharing one inference profile, as
/// `examples/kubernetes/managed-development.yaml` does. The profile names a
/// fixed stub that the flow runs in its own namespace (see `requests`). Apply
/// starts each agent through `fabric-agent-ctl`. Applying the document again,
/// and then its export, must change nothing and keep each sandbox's ID and
/// its agent's runtime ID; the first of these must also leave OpenTofu state
/// as it was. After each of these two applies, every agent must answer one
/// request from the runtime the first apply started, with the stub's reply.
/// Each sandbox must have its own ID, and its agent must be bound to it.
/// Export must recover the authored document; it also requires each sandbox's
/// provider registrations and policy on the gateway to be the ones compiled
/// for that sandbox, and the policies differ between sandboxes. Destroy must
/// remove every `Sandbox` object and keep the gateway's storage: its
/// namespace, encryption key and claims keep their UIDs. A failed apply
/// prints the namespace's pods, events and log tails; a failed request also
/// prints the stub's.
///
/// `cargo ci live-kind` also provides:
/// - `NEMOCLAW_TEST_BUNDLE`: the verified bundle
/// - `NEMOCLAW_TEST_AGENT_IMAGE`: the agent image by digest, loaded into kind
/// - `NEMOCLAW_TEST_AGENT_HARNESS`: its Fabric adapter
/// - `NEMOCLAW_TEST_AGENT_METADATA`: its metadata bundle
async fn deploy_and_export(
    provider: &str,
    sandboxes: &[(&str, &str)],
    while_applying: impl AsyncFnOnce(&str),
) {
    let _ = deploy_image_and_export(
        provider,
        &required("NEMOCLAW_TEST_AGENT_IMAGE"),
        &required("NEMOCLAW_TEST_AGENT_METADATA"),
        &[],
        sandboxes,
        while_applying,
    )
    .await;
}

async fn deploy_image_and_export(
    provider: &str,
    image: &str,
    metadata: &str,
    pull_secrets: &[&str],
    sandboxes: &[(&str, &str)],
    while_applying: impl AsyncFnOnce(&str),
) -> Vec<u8> {
    use nemoclaw_sdk::{CancellationToken, Deployment};
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
    let namespace = format!("nc-live-{}", &hex[..12]);
    let stub = requests::Stub::new(format!("nc-model-{}", &hex[..12]));
    let document = agent_document(
        provider,
        &uid,
        &namespace,
        image,
        pull_secrets,
        sandboxes,
        &stub.endpoint(),
    );
    // The SDK names the gateway's Helm release from metadata.uid alone.
    let release = format!("{}-gateway", document.workspace());
    let state = tempfile::tempdir().unwrap();
    // Live kind runs on Linux. Supply a caller-relative kubeconfig through
    // the public SDK while keeping the private fixture outside the checkout.
    let caller = std::env::current_dir().unwrap();
    let from_root: PathBuf = caller.ancestors().skip(1).map(|_| "..").collect();
    let kubeconfig = std::path::absolute(required("NEMOCLAW_TEST_KUBECONFIG")).unwrap();
    let relative = from_root.join(kubeconfig.strip_prefix("/").unwrap());
    // Connect before deploying, so a bad kubeconfig leaves nothing to remove.
    let target = ClusterTarget {
        kubeconfig,
        context: required("NEMOCLAW_TEST_KUBE_CONTEXT"),
    };
    let cluster = connect(&target).await.unwrap();
    // The requests reach the gateway as the SDK's providers do, from the
    // deployment's Kubernetes state.
    let operations = Operations {
        server: server(&target).unwrap(),
        client: cluster.clone(),
        state: state.path().join("kubernetes"),
        openshift_wait: nemoclaw_sdk::kubernetes::operations::OPENSHIFT_WAIT,
    };
    let credentials = Values(BTreeMap::from([
        (
            "NEMOCLAW_TEST_KUBECONFIG".into(),
            relative.to_string_lossy().into_owned(),
        ),
        ("NEMOCLAW_TEST_AGENT_METADATA".into(), metadata.to_owned()),
    ]));
    let deployment = Deployment::new(
        state.path(),
        std::path::Path::new(&required("NEMOCLAW_TEST_BUNDLE")),
    )
    .with_secrets(Arc::new(credentials));
    let cancel = CancellationToken::new();
    // The stub's pod starts while the deployment applies.
    stub.place(&cluster).await;

    // Stop waiting on the caller's hook if apply fails first, so the error and
    // the namespace's state show. Every pod exists once apply succeeds, so
    // the hook then gets 30 s more; destroy still runs if it never finishes,
    // before nextest stops the test.
    let apply = deployment.apply(&document, &cancel);
    let hook = while_applying(&namespace);
    tokio::pin!(apply, hook);
    let applied = tokio::select! {
        result = &mut apply => {
            if result.is_ok()
                && tokio::time::timeout(Duration::from_secs(30), &mut hook).await.is_err()
            {
                eprintln!("the caller's hook did not finish within 30 s of a successful apply");
            }
            result
        }
        () = &mut hook => apply.await,
    };
    let applied = diagnosed(applied, &cluster, &namespace).await;
    // A failed first apply leaves the deployment, as before, but not the stub,
    // whose state does not explain the failure.
    if applied.is_err() {
        stub.remove(&cluster).await;
    }
    applied.expect("the agent starts through fabric-agent-ctl");
    let state_file = state.path().join("terraform.tfstate");
    let state_snapshot = fs::read(&state_file).unwrap();
    let applied_identities = identities(state.path(), &document);
    // Each request goes to the sandbox and runtime the first apply recorded.
    let agents: Option<Vec<requests::Agent>> = applied_identities.as_ref().ok().map(|identities| {
        sandboxes
            .iter()
            .map(|(sandbox, agent)| requests::Agent {
                sandbox: (*sandbox).into(),
                name: (*agent).into(),
                binding: sandbox_binding(state.path(), sandbox),
                runtime: identities[*sandbox].runtime.clone(),
            })
            .collect()
    });

    // A complete deployment must apply unchanged, be exportable, and accept
    // its export unchanged, and its agents must answer after each of these
    // applies. Clean up before asserting so a failed check retains no live
    // workload after this test. Storage is observed after these steps, so
    // the comparison spans destroy alone.
    let unchanged = diagnosed(
        deployment.apply(&document, &cancel).await,
        &cluster,
        &namespace,
    )
    .await;
    let unchanged_state = fs::read(&state_file).unwrap();
    let stub_ready = stub.ready(&cluster).await;
    // Without the first apply's identities or the stub, no request is sent;
    // both are asserted after destroy.
    let requested = agents.as_deref().filter(|_| stub_ready.is_ok());
    let after_unchanged = match requested {
        Some(agents) => requests::round(&operations, agents, &[]).await,
        None => Vec::new(),
    };
    let exported = deployment.export(&cancel).await;
    let reapplied = match &exported {
        Ok(exported) => Some(
            diagnosed(
                deployment.apply(exported, &cancel).await,
                &cluster,
                &namespace,
            )
            .await,
        ),
        Err(_) => None,
    };
    let after_export = match requested {
        Some(agents) => requests::round(&operations, agents, &after_unchanged).await,
        None => Vec::new(),
    };
    let unanswered: Vec<String> = requested
        .into_iter()
        .flat_map(|agents| {
            [
                ("after the unchanged apply", &after_unchanged),
                ("after the export's apply", &after_export),
            ]
            .into_iter()
            .flat_map(|(round, answers)| requests::problems(round, agents, answers, &stub.reply))
        })
        .collect();
    if stub_ready.is_err() || !unanswered.is_empty() {
        eprintln!("{}", namespace_diagnostics(&cluster, &stub.namespace).await);
        eprintln!("{}", namespace_diagnostics(&cluster, &namespace).await);
    }
    let reapplied_state = fs::read(&state_file).unwrap();
    let reapplied_identities = identities(state.path(), &document);
    let deployed_objects = sandbox_objects(&cluster, &namespace).await;
    let kept = retained(&cluster, &namespace, &release).await;
    let destroyed = deployment.destroy(&cancel).await;
    stub.remove(&cluster).await;
    let destroyed = destroyed.unwrap();
    let remaining = retained(&cluster, &namespace, &release).await;
    let objects_left = sandbox_objects_left(&cluster, &namespace).await;
    for change in &destroyed.changes {
        assert!(
            !change.resource.contains("kubernetes_storage"),
            "destroy keeps the gateway's storage: {}",
            change.resource
        );
    }
    let unchanged = unchanged.expect("an unchanged apply must succeed");
    assert!(
        unchanged.changes.is_empty(),
        "an unchanged apply changes nothing: {:?}",
        unchanged.changes
    );
    // Export refreshes each sandbox from the gateway and compares its provider
    // registrations and policy with those compiled for it. The policies differ
    // between sandboxes, so a sandbox holding another's policy fails export,
    // if the unchanged apply's refresh has not already failed.
    assert_eq!(
        exported.expect("export of the applied deployment must succeed"),
        document,
        "export recovers the authored configuration without readiness checks"
    );
    let reapplied = reapplied
        .expect("the export was applied")
        .expect("applying the export must succeed");
    assert!(
        reapplied.changes.is_empty(),
        "applying the export changes nothing: {:?}",
        reapplied.changes
    );
    // The first apply records the sandbox's policy hash as empty until the
    // gateway reports the policy loaded, and the auth resource's Helm release
    // as absent until the release exists; the unchanged apply's refresh
    // records both. From then on, state must not change.
    assert_same_deployment_state(&reapplied_state, &unchanged_state);
    let applied_identities =
        applied_identities.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
    let reapplied_identities =
        reapplied_identities.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
    assert_eq!(
        reapplied_identities, applied_identities,
        "unchanged applies keep each sandbox and its agent's runtime"
    );
    let sandbox_ids: BTreeSet<_> = applied_identities
        .values()
        .map(|identity| &identity.sandbox)
        .collect();
    assert_eq!(
        sandbox_ids.len(),
        document.spec.sandboxes.len(),
        "each sandbox has its own ID"
    );
    // Fabric makes runtime IDs unique only within one process, and each
    // sandbox runs its own, so the binding identifies the agent instead.
    for (name, identity) in &applied_identities {
        assert_eq!(
            identity.agent_sandbox, identity.sandbox,
            "the agent in sandbox {name} is bound to that sandbox"
        );
    }
    assert_eq!(
        deployed_objects
            .expect("Sandbox objects are observable before destroy")
            .len(),
        document.spec.sandboxes.len(),
        "the namespace holds one Sandbox object per sandbox before destroy"
    );
    assert_eq!(
        objects_left.expect("Sandbox objects are observable after destroy"),
        BTreeSet::new(),
        "destroy removes every Sandbox object"
    );
    assert!(
        kept.expect("the gateway's storage is observable before destroy")
            == remaining.expect("the gateway's storage is observable after destroy"),
        "namespace, encryption key and gateway PVC identities survive SDK destroy"
    );
    stub_ready.unwrap_or_else(|error| panic!("{error}"));
    // Fabric reports no runtime status, so a stopped runtime is found when it
    // is next invoked: an answer from the first apply's runtime shows that it
    // still runs. The stub's reply shows that the agent's request reached it.
    assert!(
        unanswered.is_empty(),
        "each agent answers from its first runtime with the stub's reply:\n{}",
        unanswered.join("\n")
    );
    state_snapshot
}

/// The sandboxes the OpenShift-profile test deploys, with their agents.
const THREE_AGENTS: [(&str, &str); 3] = [
    ("assistant", "main"),
    ("researcher", "researcher"),
    ("reviewer", "reviewer"),
];

/// Three agents on one gateway with the OpenShift profile, on kind. kind does
/// not enforce OpenShift's security policy, but the SDK and OpenShell both
/// read the UID range OpenShift writes on each namespace, and that works on
/// any cluster. The test writes the range itself once the namespace exists,
/// as OpenShift would, then checks that the gateway and each sandbox's agent
/// pod ran as its first UID. The shared flow checks that each agent keeps its
/// own identities and, after the unchanged apply and the export's apply,
/// answers a request from the runtime the first apply started; a fixed stub
/// replies, so no model runs. The agents share this test's gateway to keep
/// the live-kind suite within its 270-second budget.
#[tokio::test]
#[ignore = "needs a Kubernetes cluster with Agent Sandbox and a loaded agent image; run through cargo ci live-kind"]
async fn on_openshift_three_agents_keep_separate_identities_run_as_the_namespace_uid_and_answer_after_each_reapply()
 {
    use k8s_openapi::api::core::v1::{Namespace, Pod};
    use kube::{
        Api,
        api::{ListParams, Patch, PatchParams},
    };
    const RANGE: &str = "1000680000/10000";
    let kubeconfig =
        kube::config::Kubeconfig::read_from(required("NEMOCLAW_TEST_KUBECONFIG")).unwrap();
    let options = kube::config::KubeConfigOptions {
        context: Some(required("NEMOCLAW_TEST_KUBE_CONTEXT")),
        ..Default::default()
    };
    let client = nemoclaw_sdk::kubernetes::client(
        kube::Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .unwrap(),
    )
    .unwrap();
    let observed = std::sync::Mutex::new(None::<(BTreeMap<&str, Option<i64>>, Option<i64>)>);
    deploy_and_export("openshift", &THREE_AGENTS, async |namespace| {
        // Annotate the namespace as soon as the SDK creates it, as OpenShift
        // does when a project is created.
        let namespaces: Api<Namespace> = Api::all(client.clone());
        let annotation = json!({"metadata": {"annotations": {
            "openshift.io/sa.scc.uid-range": RANGE,
            "openshift.io/sa.scc.supplemental-groups": RANGE,
        }}});
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        while namespaces
            .patch(
                namespace,
                &PatchParams::default(),
                &Patch::Merge(&annotation),
            )
            .await
            .is_err()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "the namespace was never created"
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        // Read each agent's and the gateway's users while they still run.
        let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            let listed = pods.list(&ListParams::default()).await.unwrap().items;
            let user = |suffix: &str, container: &str| {
                listed
                    .iter()
                    .find(|pod| {
                        pod.metadata
                            .name
                            .as_deref()
                            .is_some_and(|name| name.ends_with(suffix))
                    })
                    .and_then(|pod| pod.spec.as_ref())
                    .map(|spec| {
                        spec.containers
                            .iter()
                            .find(|candidate| candidate.name == container)
                            .and_then(|found| found.security_context.as_ref())
                            .and_then(|context| context.run_as_user)
                            .or_else(|| {
                                spec.security_context
                                    .as_ref()
                                    .and_then(|context| context.run_as_user)
                            })
                    })
            };
            // Each sandbox's pod is named `<workspace>--<sandbox>`.
            let agents: Option<BTreeMap<_, _>> = THREE_AGENTS
                .iter()
                .map(|(sandbox, _)| Some((*sandbox, user(&format!("--{sandbox}"), "agent")?)))
                .collect();
            if let (Some(agents), Some(gateway)) = (agents, user("-gateway-0", "openshell-gateway"))
            {
                *observed.lock().unwrap() = Some((agents, gateway));
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the agent and gateway pods never appeared"
            );
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    })
    .await;
    let (agents, gateway) = observed
        .into_inner()
        .unwrap()
        .expect("the agent and gateway pods appeared");
    assert_eq!(
        agents,
        THREE_AGENTS
            .map(|(sandbox, _)| (sandbox, Some(1_000_680_000)))
            .into(),
        "each sandbox's agent pod runs as the namespace's first UID"
    );
    assert_eq!(
        gateway,
        Some(1_000_680_000),
        "the gateway runs as the namespace's first UID"
    );
}
