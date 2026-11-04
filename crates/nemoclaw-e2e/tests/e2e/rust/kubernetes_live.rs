// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Exercise the compiled Kubernetes runtime graph with the bundled OpenTofu
//! and providers, with no Helm executable on PATH. Requires an owned cluster
//! with Agent Sandbox, its explicit kubeconfig/context, and a verified bundle.

use k8s_openapi::api::{
    apps::v1::StatefulSet,
    core::v1::{Namespace, PersistentVolumeClaim, Secret},
};
use kube::{Api, api::ListParams};
use nemoclaw_sdk::{
    ObservationError,
    bundle::Bundle,
    compile::{Generations, compile_runtime, compile_teardown, runtime_targets},
    config::{ComputeDriver, Document, ExternalGateway, FileRef, Gateway, SecretRef, TLS},
    kubernetes::{
        CA_ENV, CERT_ENV, ClusterTarget, GATEWAY_KIND, KEY_ENV, STATE_ENV, STORAGE_KIND, Spec,
        TOKEN_ENV, connect, operations::Operations,
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
    std::env::var(name).unwrap_or_else(|_| {
        panic!("{name} is required; see internal-docs/contributing/live-tests.md")
    })
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
            certificate: Some(file(CERT_ENV)),
            key: Some(file(KEY_ENV)),
        }),
        ..Default::default()
    });
    OpenShell::connect(&gateway.connection(), Arc::new(Values(environment)))
}

/// Connect to the managed gateway that `binding` records, as the SDK's
/// providers do. The connection holds the port-forward. `hcl_live::probe`
/// reaches a kind case's agents through it.
pub(crate) async fn gateway(
    operations: &Operations,
    binding: &nemoclaw_sdk::backend::Row,
) -> Result<(nemoclaw_sdk::kubernetes::Connection, OpenShell), String> {
    let spec: Spec = binding
        .get("gateway_kubernetes")
        .and_then(|spec| serde_json::from_str(spec).ok())
        .ok_or("the binding names no managed Kubernetes gateway")?;
    let connection = operations
        .connect(&spec)
        .await
        .map_err(|error| format!("cannot connect to the gateway: {error}"))?;
    let client = gateway_client(&connection, connection.environment())
        .map_err(|error| format!("cannot connect to the gateway: {error}"))?;
    Ok((connection, client))
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

/// What the kind-openshift-agents HCL E2E scenario cannot show about the
/// development gateway: that it refuses a token signed by another key, and
/// that removing and reinstalling it keeps the namespace, encryption key, and
/// PVCs with their UIDs. It runs the compiled runtime and teardown graphs with
/// an empty `PATH`, so no host Helm executable can stand in for the bundled
/// provider.
#[tokio::test]
#[ignore = "needs an owned cluster with Agent Sandbox and a verified bundle; see live-tests.md"]
async fn the_gateway_refuses_a_foreign_token_and_reinstalls_on_its_retained_storage() {
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
        include_bytes!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_slice(),
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
    value["spec"]["sandboxes"]["assistant"]["image"]["metadata"] =
        json!({"env": "TEST_IMAGE_METADATA"});
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
    Api::<Namespace>::all(operations.client.clone())
        .delete(&namespace, &kube::api::DeleteParams::foreground())
        .await
        .unwrap();
}
