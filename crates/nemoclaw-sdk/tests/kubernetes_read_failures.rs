// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A failed Kubernetes read is never treated as confirmed absence.
//!
//! Each test fails one request that the SDK's Kubernetes operations send to the
//! API server (HTTP 401, 403 or 500, or a dropped connection), answers it
//! without a UID, which an API server never does, or serves a client TLS Secret
//! that lacks a key. The call must report the failure's error class and send no
//! write, and the cluster objects and recorded state must stay as they were,
//! with three exceptions that the tests name: the cluster binding that the first
//! `ensure` of storage saves before it reads the prerequisites, the one object
//! whose create reply lost its UID, and the client files that `connect` writes
//! before the next read.
#![cfg(unix)]

use crate::kube_api::{Objects, client, collection};
use crate::kube_faults::{
    Fault, Snapshot,
    platform::{self, Call, NAME, OWNER, assert_class, run},
    serve,
};
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::{
        AUTH_KIND, GATEWAY_KIND, STORAGE_KIND,
        operations::Operations,
        receipt::{ClusterIdentity, Receipt},
    },
};
use serde_json::{Value, json};
use std::path::PathBuf;

const NAMESPACE_PATH: &str = "/api/v1/namespaces/agents";
const SECRETS_PATH: &str = "/api/v1/namespaces/agents/secrets";
const CRD_PATH: &str =
    "/apis/apiextensions.k8s.io/v1/customresourcedefinitions/sandboxes.agents.x-k8s.io";
const CONTROLLER_PATH: &str =
    "/apis/apps/v1/namespaces/agent-sandbox-system/deployments/agent-sandbox-controller";

fn statefulset_path() -> String {
    format!("/apis/apps/v1/namespaces/agents/statefulsets/{NAME}")
}

/// A fault and the error classes a call that meets it can report.
type Injection = (Fault, &'static [ObservationError]);

/// Each fault with the one class every read below must report for it.
const FAULTS: [Injection; 4] = [
    (Fault::Status(401), &[ObservationError::Authentication]),
    (Fault::Status(403), &[ObservationError::Permission]),
    (Fault::Status(500), &[ObservationError::Query]),
    (Fault::Dropped, &[ObservationError::Transport]),
];

/// The calls that verify the recorded storage objects.
const STORAGE_CALLS: [Call; 8] = [
    Call::Read(STORAGE_KIND),
    Call::Ensure(STORAGE_KIND),
    Call::Read(AUTH_KIND),
    Call::ReadForRemoval(AUTH_KIND),
    Call::Ensure(AUTH_KIND),
    Call::Ensure(GATEWAY_KIND),
    Call::Remove(AUTH_KIND),
    Call::Connect,
];

/// The calls that also verify the issuer objects, the gateway and the Helm
/// release record. Every one of them verifies storage first.
const AUTH_CALLS: [Call; 6] = [
    Call::Read(AUTH_KIND),
    Call::ReadForRemoval(AUTH_KIND),
    Call::Ensure(AUTH_KIND),
    Call::Ensure(GATEWAY_KIND),
    Call::Remove(AUTH_KIND),
    Call::Connect,
];

/// Remove the uid from the stored object at `path`; inserting one assigns it.
fn drop_uid(objects: &Objects, path: &str) {
    objects.0.lock().unwrap().get_mut(path).unwrap()["metadata"]
        .as_object_mut()
        .unwrap()
        .remove("uid");
}

/// A cluster and state directory brought to a start state by successful calls.
struct Applied {
    objects: Objects,
    /// The state directory; the receipt is `state/receipt.json`.
    state: PathBuf,
    /// The server address the first apply recorded in the receipt. Later calls
    /// reach a different fake server and must still present this address.
    server: String,
    provider: &'static str,
    _directory: tempfile::TempDir,
}

/// The Namespace annotations OpenShift writes when it creates a project.
fn assign_openshift_range(objects: &Objects) {
    platform::annotate_namespace(
        objects,
        json!({
            "openshift.io/sa.scc.uid-range": "1000680000/10000",
            "openshift.io/sa.scc.supplemental-groups": "1000690000/10000",
        }),
    );
}

/// The Secret the chart creates for client access, with only `keys` present.
fn client_tls(keys: &[&str]) -> Value {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut data = serde_json::Map::new();
    for key in keys {
        data.insert(
            (*key).into(),
            json!(STANDARD.encode(format!("synthetic {key}"))),
        );
    }
    json!({"apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/tls",
        "metadata": {"name": format!("{NAME}-client-tls"), "namespace": "agents"}, "data": data})
}

/// Apply `kinds` in order. Applying the gateway first installs what Helm would
/// leave: the ready StatefulSet, then the client TLS Secret.
async fn applied(provider: &'static str, kinds: &[&str]) -> Applied {
    let objects = platform::cluster();
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let fixture = objects.serve().await;
    let operations = platform::operations(client(&fixture), &fixture.endpoint, &state);
    for kind in kinds {
        match *kind {
            AUTH_KIND if provider == "openshift" => assign_openshift_range(&objects),
            GATEWAY_KIND => platform::ready_gateway(&objects),
            _ => {}
        }
        operations
            .ensure(&platform::spec_on(kind, provider), None)
            .await
            .unwrap();
    }
    if kinds.contains(&GATEWAY_KIND) {
        objects.insert(client_tls(&["ca.crt", "tls.crt", "tls.key"]));
    }
    Applied {
        objects,
        state,
        server: fixture.endpoint.clone(),
        provider,
        _directory: directory,
    }
}

/// Storage, authentication and the gateway applied.
async fn fully_applied(provider: &'static str) -> Applied {
    applied(provider, &[STORAGE_KIND, AUTH_KIND, GATEWAY_KIND]).await
}

impl Applied {
    /// Operations over `client`, presenting the server address of the first apply.
    fn operations(&self, client: kube::Client) -> Operations {
        platform::operations(client, &self.server, &self.state)
    }
}

/// Which GET of a path to fail.
#[derive(Clone, Copy, Debug)]
enum Site<'a> {
    /// Every GET of the path; the call stops at the first.
    First,
    /// The GET of the path that comes straight after a GET of this other path.
    /// A call reads some paths more than once, and the read before a request
    /// says which one it is; counting the requests would instead point at a
    /// different read when production adds or drops a repeated one.
    After(&'a str),
}

/// Fail the GETs of `path` at `site` as `fault` during `call`. The fault must
/// fire once, and the call must report one of `accepted` and send no write.
/// Returns the failure context for the caller's messages.
async fn fail_read(
    applied: &Applied,
    path: &str,
    site: Site<'_>,
    call: Call,
    (fault, accepted): Injection,
) -> String {
    let anchor = match site {
        Site::First => None,
        Site::After(previous) => Some(previous.to_owned()),
    };
    let (target, mut previous) = (path.to_owned(), String::new());
    let server = serve(&applied.objects, move |method, found, _| {
        let follows = anchor.as_ref().is_none_or(|anchor| *anchor == previous);
        previous = found.to_owned();
        (method == "GET" && found == target && follows).then_some(fault)
    })
    .await;
    let operations = applied.operations(server.client());
    let result = run(&operations, applied.provider, call).await;
    let context = format!(
        "{call:?} with {fault:?} on GET {path} ({site:?}), requests: {:?}",
        server.requests()
    );
    assert_eq!(
        server.faults_fired(),
        1,
        "the fault must fire exactly once: {context}"
    );
    assert_class(&result, accepted, &context);
    let writes = server.mutations();
    assert!(writes.is_empty(), "{context}: mutating requests {writes:?}");
    context
}

/// Fail `path` at `site` as each fault in `FAULTS` during each of `calls`; the
/// cluster and the state directory must stay exactly as they were.
async fn assert_reads_fail(applied: &Applied, path: &str, site: Site<'_>, calls: &[Call]) {
    for &call in calls {
        for injection in FAULTS {
            let before = Snapshot::capture(&applied.objects, &applied.state);
            let context = fail_read(applied, path, site, call, injection).await;
            before.assert_unchanged(&applied.objects, &applied.state, &context);
        }
    }
}

/// Run `call` against a server that answers `path` incompletely, because the
/// stored object lacks something. The call must stop at that read with
/// `Incomplete`, send no write and change nothing. `connect` writes each
/// credential it has decoded to `state/client` before it reads the next; those
/// files are for the command and not recorded state, so `written` names the
/// ones expected, and they are removed before the comparison.
async fn assert_incomplete(applied: &Applied, call: Call, path: &str, written: &[&str]) {
    let before = Snapshot::capture(&applied.objects, &applied.state);
    let server = serve(&applied.objects, |_, _, _| None).await;
    let operations = applied.operations(server.client());
    let result = run(&operations, applied.provider, call).await;
    let context = format!(
        "{call:?} with an incomplete answer to GET {path}, requests: {:?}",
        server.requests()
    );
    assert_class(&result, &[ObservationError::Incomplete], &context);
    let last = server.requests().pop();
    assert_eq!(
        last,
        Some(("GET".into(), path.into())),
        "stopped elsewhere: {context}"
    );
    assert!(
        server.mutations().is_empty(),
        "{context}: mutating requests"
    );
    let client = applied.state.join("client");
    let mut left: Vec<_> = std::fs::read_dir(&client)
        .into_iter()
        .flatten()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, written, "{context}: files left in state/client");
    let _ = std::fs::remove_dir_all(&client);
    before.assert_unchanged(&applied.objects, &applied.state, &context);
}

/// The receipt a first apply holds once it has bound the cluster.
fn bound(server: &str) -> Receipt {
    let mut receipt = Receipt::new(OWNER, NAME);
    receipt.cluster = Some(ClusterIdentity {
        server: server.into(),
        system_uid: "system-1".into(),
    });
    receipt
}

/// Start state: first apply. The receipt is bound after the identity read and
/// before the prerequisite reads, so a failed prerequisite read (`binds`) leaves
/// the binding and nothing else, and a failed identity read leaves no receipt.
/// Nothing is created in the cluster either way.
async fn assert_prerequisite_read_fails(path: &str, injections: &[Injection], binds: bool) {
    for &injection in injections {
        let applied = applied("kubernetes", &[]).await;
        let before = applied.objects.0.lock().unwrap().clone();
        let call = Call::Ensure(STORAGE_KIND);
        let context = fail_read(&applied, path, Site::First, call, injection).await;
        assert_eq!(*applied.objects.0.lock().unwrap(), before, "{context}");
        assert_eq!(
            Receipt::load(&applied.state, OWNER, NAME).unwrap(),
            binds.then(|| bound(&applied.server)),
            "{context}: the receipt differs from the cluster binding it should hold"
        );
    }
}

#[tokio::test]
async fn failed_agent_sandbox_crd_reads_are_reported_by_class_and_leave_only_the_cluster_binding() {
    assert_prerequisite_read_fails(CRD_PATH, &FAULTS, true).await;
}

#[tokio::test]
async fn failed_agent_sandbox_controller_reads_are_reported_by_class_and_leave_only_the_cluster_binding()
 {
    assert_prerequisite_read_fails(CONTROLLER_PATH, &FAULTS, true).await;
}

/// Start state: first apply. Storage reports every failure other than 401 and
/// 403 as Transport (`storage.rs`), where the other reads report a 500 as Query.
#[tokio::test]
async fn a_server_error_on_the_cluster_identity_or_storage_class_read_is_a_transport_failure() {
    let server_error: [Injection; 1] = [(Fault::Status(500), &[ObservationError::Transport])];
    for (path, binds) in [
        ("/api/v1/namespaces/kube-system", false),
        ("/apis/storage.k8s.io/v1/storageclasses", true),
    ] {
        assert_prerequisite_read_fails(path, &server_error, binds).await;
    }
}

/// Start state: nothing applied. The identity is incomplete, so nothing binds.
#[tokio::test]
async fn a_cluster_identity_answer_without_a_uid_is_incomplete_and_binds_nothing() {
    let applied = applied("kubernetes", &[]).await;
    let path = "/api/v1/namespaces/kube-system";
    drop_uid(&applied.objects, path);
    assert_incomplete(&applied, Call::Ensure(STORAGE_KIND), path, &[]).await;
}

/// Start states: first apply (the Namespace is the first create) and storage
/// applied (the issuer's first object is the first create). The create reaches
/// the cluster and only its reply lacks the UID, so the one object it made
/// exists. The call must record nothing, retry nothing and delete nothing.
/// That object stays in the cluster unrecorded; a later change that adopts or
/// removes it after verifying ownership is expected to change this test.
#[tokio::test]
async fn a_created_object_reply_without_a_uid_is_incomplete_and_is_not_recorded() {
    for (done, kind, post) in [
        (&[][..], STORAGE_KIND, "/api/v1/namespaces"),
        (
            &[STORAGE_KIND][..],
            AUTH_KIND,
            "/api/v1/namespaces/agents/configmaps",
        ),
    ] {
        let applied = applied("kubernetes", done).await;
        let before = applied.objects.0.lock().unwrap().clone();
        let receipt = Receipt::load(&applied.state, OWNER, NAME).unwrap();
        let server = serve(&applied.objects, move |method, found, _| {
            (method == "POST" && found == post).then_some(Fault::CommitThenOmitUid)
        })
        .await;
        let operations = applied.operations(server.client());
        let result = run(&operations, applied.provider, Call::Ensure(kind)).await;
        let context = format!("{kind} create reply without a uid on POST {post}");
        assert_class(&result, &[ObservationError::Incomplete], &context);
        assert_eq!(
            server.mutations(),
            [("POST".to_owned(), post.to_owned())],
            "{context}: expected exactly the one create and no retry or delete"
        );
        let after = applied.objects.0.lock().unwrap().clone();
        assert!(
            after.len() == before.len() + 1
                && before
                    .iter()
                    .all(|(key, object)| after.get(key) == Some(object)),
            "{context}: expected the created object only and no change to an existing one"
        );
        // A first create follows the cluster binding; a later one leaves the receipt as it was.
        let expected = receipt.unwrap_or_else(|| bound(&applied.server));
        assert_eq!(
            Receipt::load(&applied.state, OWNER, NAME).unwrap(),
            Some(expected),
            "{context}: the receipt recorded the created object"
        );
    }
}

/// Start state: everything applied.
#[tokio::test]
async fn failed_namespace_verification_reads_are_reported_by_class_and_change_nothing() {
    let applied = fully_applied("kubernetes").await;
    assert_reads_fail(&applied, NAMESPACE_PATH, Site::First, &STORAGE_CALLS).await;
}

/// Start state: everything applied.
#[tokio::test]
async fn failed_credential_key_reads_are_reported_by_class_and_change_nothing() {
    let applied = fully_applied("kubernetes").await;
    let path = format!("{SECRETS_PATH}/{NAME}-kek");
    assert_reads_fail(&applied, &path, Site::First, &STORAGE_CALLS).await;
}

/// Start state: everything applied. Every recorded issuer object is read.
#[tokio::test]
async fn failed_issuer_object_reads_are_reported_by_class_and_change_nothing() {
    let applied = fully_applied("kubernetes").await;
    let receipt = Receipt::load(&applied.state, OWNER, NAME).unwrap().unwrap();
    let issuer = receipt.issuer;
    assert!(!issuer.is_empty(), "the issuer objects are not recorded");
    for owned in issuer {
        let collection = collection(&owned.api_version, &owned.kind, &owned.namespace);
        let path = format!("{collection}/{}", owned.name);
        assert_reads_fail(&applied, &path, Site::First, &AUTH_CALLS).await;
    }
}

/// Start states: everything applied, and released (Helm removed the release and
/// its StatefulSet while the receipt still records the gateway). Teardown accepts
/// a confirmed absence but never a failed read of it, and deletes nothing then.
#[tokio::test]
async fn failed_gateway_statefulset_reads_are_reported_by_class_and_change_nothing() {
    let applied = fully_applied("kubernetes").await;
    let path = statefulset_path();
    let calls = [
        &AUTH_CALLS[..],
        &[
            Call::Read(GATEWAY_KIND),
            Call::ReadForRemoval(GATEWAY_KIND),
            Call::Remove(GATEWAY_KIND),
        ],
    ]
    .concat();
    assert_reads_fail(&applied, &path, Site::First, &calls).await;
    applied
        .objects
        .0
        .lock()
        .unwrap()
        .retain(|key, _| !key.contains("/statefulsets/"));
    let removal = [
        Call::ReadForRemoval(AUTH_KIND),
        Call::Remove(AUTH_KIND),
        Call::ReadForRemoval(GATEWAY_KIND),
        Call::Remove(GATEWAY_KIND),
    ];
    assert_reads_fail(&applied, &path, Site::First, &removal).await;
    // Issuer cleanup lists the Helm release records, then confirms a second
    // time that the StatefulSet is absent before it deletes.
    let second = Site::After(SECRETS_PATH);
    assert_reads_fail(&applied, &path, second, &[Call::Remove(AUTH_KIND)]).await;
}

/// Start state: storage and authentication applied, and a ready StatefulSet
/// that the receipt does not record. The first `ensure` of the gateway reads it
/// to adopt its identity, and records that identity only after the read.
#[tokio::test]
async fn failed_gateway_statefulset_reads_before_adoption_are_reported_by_class_and_record_nothing()
{
    let applied = applied("kubernetes", &[STORAGE_KIND, AUTH_KIND]).await;
    platform::ready_gateway(&applied.objects);
    let call = [Call::Ensure(GATEWAY_KIND)];
    assert_reads_fail(&applied, &statefulset_path(), Site::First, &call).await;
}

/// Start state: everything applied.
#[tokio::test]
async fn failed_helm_release_listings_are_reported_by_class_and_change_nothing() {
    let applied = fully_applied("kubernetes").await;
    assert_reads_fail(&applied, SECRETS_PATH, Site::First, &AUTH_CALLS).await;
}

/// Start state: everything applied. `connect` has created the empty `client`
/// directory before it reads the Secret, so it must still exist, with no file
/// in it; `Snapshot` records files only, so it does not see the directory.
#[tokio::test]
async fn failed_client_tls_secret_reads_are_reported_by_class_and_write_no_credential() {
    let applied = fully_applied("kubernetes").await;
    let path = format!("{SECRETS_PATH}/{NAME}-client-tls");
    assert_reads_fail(&applied, &path, Site::First, &[Call::Connect]).await;
    assert!(
        applied.state.join("client").is_dir(),
        "connect never reached the Secret read"
    );
}

/// Start state: everything applied. `connect` decodes `ca.crt`, `tls.crt` and
/// `tls.key` in that order and writes each to `state/client` before it reads
/// the next, so a Secret that lacks one leaves the ones before it. The key is
/// written last, so no failure leaves it behind.
#[tokio::test]
async fn a_client_tls_secret_missing_a_credential_is_incomplete_and_leaves_only_the_earlier_ones() {
    let applied = fully_applied("kubernetes").await;
    let path = format!("{SECRETS_PATH}/{NAME}-client-tls");
    for (missing, written) in [
        ("ca.crt", &[][..]),
        ("tls.crt", &["ca.crt"][..]),
        ("tls.key", &["ca.crt", "tls.crt"][..]),
    ] {
        let keys: Vec<_> = ["ca.crt", "tls.crt", "tls.key"]
            .into_iter()
            .filter(|key| *key != missing)
            .collect();
        applied.objects.insert(client_tls(&keys));
        assert_incomplete(&applied, Call::Connect, &path, written).await;
    }
}

/// Start state: storage and authentication applied, then Helm installs a
/// gateway whose StatefulSet carries no uid, so there is no identity to record.
/// A gateway that is already recorded gives `BindingMismatch` instead.
#[tokio::test]
async fn an_unrecorded_gateway_statefulset_without_a_uid_is_incomplete_and_is_not_recorded() {
    let applied = applied("kubernetes", &[STORAGE_KIND, AUTH_KIND]).await;
    platform::ready_gateway(&applied.objects);
    let path = statefulset_path();
    drop_uid(&applied.objects, &path);
    assert_incomplete(&applied, Call::Ensure(GATEWAY_KIND), &path, &[]).await;
}

/// Start state: OpenShift storage applied and its Namespace assigned a range.
/// `ensure` reads the Namespace identity right after it lists the Helm release
/// records, and writes no issuer object until that read succeeds.
#[tokio::test]
async fn a_failed_openshift_namespace_identity_read_writes_no_issuer_object() {
    let applied = applied("openshift", &[STORAGE_KIND]).await;
    assign_openshift_range(&applied.objects);
    let site = Site::After(SECRETS_PATH);
    assert_reads_fail(&applied, NAMESPACE_PATH, site, &[Call::Ensure(AUTH_KIND)]).await;
}

/// Start state: OpenShift everything applied. A refresh compares the recorded
/// Namespace identity right after it reads the gateway StatefulSet.
#[tokio::test]
async fn a_failed_openshift_namespace_identity_comparison_read_is_reported_by_class() {
    let applied = fully_applied("openshift").await;
    let site = Site::After(&statefulset_path());
    assert_reads_fail(&applied, NAMESPACE_PATH, site, &[Call::Read(AUTH_KIND)]).await;
}
