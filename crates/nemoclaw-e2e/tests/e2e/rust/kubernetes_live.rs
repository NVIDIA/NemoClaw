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
pub(crate) mod requests;

use k8s_openapi::api::core::v1::{Namespace, PersistentVolumeClaim, Secret};
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
    config::{Document, ExternalGateway, FileRef, Gateway, SecretRef, TLS},
    kubernetes::{
        CA_ENV, CERT_ENV, ClusterTarget, KEY_ENV, Spec, TOKEN_ENV, connect, operations::Operations,
    },
};
use openshell_provider::{OpenShell, Secrets};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
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

/// Print the namespace's diagnostics and Fabric's saved messages if `applied`
/// failed, while its pods still exist; the caller asserts the result.
async fn diagnosed<T, E>(
    applied: Result<T, E>,
    client: &kube::Client,
    namespace: &str,
    state: &Path,
) -> Result<T, E> {
    if applied.is_err() {
        eprintln!("{}", namespace_diagnostics(client, namespace).await);
        eprint!("{}", fabric_messages(state));
    }
    applied
}

/// Fabric's own messages about failed runtime operations, which the Fabric
/// provider keeps in the deployment state directory `state` as
/// `diagnostics/fabric-SANDBOX.json` instead of in its errors. A message can
/// repeat what the harness printed, so it is redacted and bounded as backend
/// rejections are.
fn fabric_messages(state: &Path) -> String {
    let Ok(entries) = fs::read_dir(state.join("diagnostics")) else {
        return String::new();
    };
    let mut saved: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let sandbox = name.strip_prefix("fabric-")?.strip_suffix(".json")?;
            Some((sandbox.to_owned(), entry.path()))
        })
        .collect();
    saved.sort();
    let mut out = String::new();
    for (sandbox, path) in saved {
        let saved: Value = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let field =
            |key: &str| ObservationError::sanitized_detail(saved[key].as_str().unwrap_or("?"));
        out += &format!(
            "Fabric's message for sandbox {sandbox} at {} ({}, effects {}): {}\n",
            field("stage"),
            field("code"),
            field("effects"),
            field("message"),
        );
    }
    out
}

#[test]
fn fabric_messages_name_each_failed_sandbox_and_redact_credentials() {
    let state = tempfile::tempdir().unwrap();
    let diagnostics = state.path().join("diagnostics");
    fs::create_dir(&diagnostics).unwrap();
    fs::write(
        diagnostics.join("fabric-reviewer.json"),
        json!({
            "stage": "start",
            "code": "start_failed",
            "effects": "unknown",
            "message": "Fabric could not establish an active runtime; Authorization: Bearer PRIVATE_SENTINEL",
        })
        .to_string(),
    )
    .unwrap();
    // OpenTofu's own output, which the runner keeps beside it, is not Fabric's.
    fs::write(diagnostics.join("001-apply.stderr"), "OPENTOFU_OUTPUT").unwrap();

    let printed = fabric_messages(state.path());

    assert!(
        printed.contains(
            "Fabric's message for sandbox reviewer at start (start_failed, effects unknown): \
             Fabric could not establish an active runtime;"
        ),
        "{printed}"
    );
    assert!(!printed.contains("PRIVATE_SENTINEL"), "{printed}");
    assert!(!printed.contains("OPENTOFU_OUTPUT"), "{printed}");
    assert!(fabric_messages(&state.path().join("absent")).is_empty());
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
            .sandboxes()
            .map(|sandbox| {
                let identity = Identity {
                    sandbox: sandbox_binding(directory, sandbox.name)["id"].clone(),
                    agent_sandbox: agent_sandbox_id(directory, sandbox.name),
                    runtime: runtime_id(directory, sandbox.name),
                };
                (sandbox.name.to_owned(), identity)
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
    {sandbox}:
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
    stub:
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
        // Pi needs a context window, input types and cost for a model it does
        // not ship, as examples/fabric-pi.yaml declares; without `input`, Pi
        // fails every request. OpenClaw declares no model extensions.
        extensions = if harness == "nvidia.fabric.pi" {
            "\n            extensions:\n              context_window: 8192\n              input: [text]\n              cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}"
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
///
/// `before_applying` runs with the namespace name before the first apply, as an
/// operator who prepares the namespace would; `while_applying` runs alongside it.
async fn deploy_image_and_export(
    provider: &str,
    image: &str,
    metadata: &str,
    pull_secrets: &[&str],
    sandboxes: &[(&str, &str)],
    before_applying: impl AsyncFnOnce(&str),
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
    before_applying(&namespace).await;
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
    let applied = diagnosed(applied, &cluster, &namespace, state.path()).await;
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
        state.path(),
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
                state.path(),
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
    // An answer from the first apply's runtime shows that it still runs. The
    // stub's reply shows that the agent's request reached it.
    assert!(
        unanswered.is_empty(),
        "each agent answers from its first runtime with the stub's reply:\n{}",
        unanswered.join("\n")
    );
    state_snapshot
}
