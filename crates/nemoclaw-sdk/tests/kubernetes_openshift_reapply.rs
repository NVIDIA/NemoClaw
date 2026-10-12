// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Re-applying OpenShift authentication after it was removed.
//!
//! The retained Namespace carries the `openshift.io/sa.scc.*` annotations, and
//! the receipt keeps the first UID and group recorded from them. Re-applying
//! authentication must refuse a changed UID range or group range, and stop at a
//! missing range, before it creates an object or changes the receipt. How an
//! operator recovers from the refusal is not covered.
#![cfg(unix)]

use crate::kube_api::Objects;
use crate::kube_faults::{FaultServer, Snapshot, platform, serve};
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::{
        AUTH_KIND, STORAGE_KIND, gateway::Identity, operations::Operations, receipt::Receipt,
    },
};
use serde_json::json;
use std::path::Path;

const UID_RANGE: &str = "openshift.io/sa.scc.uid-range";
const GROUP_RANGE: &str = "openshift.io/sa.scc.supplemental-groups";

/// Apply storage and authentication on OpenShift with the UID range starting at
/// 1000680000 and the group range at 1000690000, then remove authentication.
/// The namespace stays and the receipt keeps the identity recorded from it.
async fn removed_authentication(objects: &Objects, state: &Path) -> (FaultServer, Operations) {
    let server = serve(objects, |_, _, _| None).await;
    let operations = platform::operations(server.client(), server.endpoint(), state);
    let on = |kind| platform::spec_on(kind, "openshift");
    operations.ensure(&on(STORAGE_KIND), None).await.unwrap();
    let ranges = json!({UID_RANGE: "1000680000/10000", GROUP_RANGE: "1000690000/10000"});
    platform::annotate_namespace(objects, ranges);
    let applied = operations.ensure(&on(AUTH_KIND), None).await.unwrap();
    operations
        .remove(&on(AUTH_KIND), applied.id.as_deref())
        .await
        .unwrap();
    let receipt = Receipt::load(state, platform::OWNER, platform::NAME)
        .unwrap()
        .unwrap();
    assert!(
        receipt.issuer.is_empty(),
        "issuer objects remain recorded after removal: {:?}",
        receipt.issuer
    );
    let identity = Identity {
        user: 1_000_680_000,
        group: 1_000_690_000,
    };
    assert_eq!(receipt.namespace_identity, Some(identity));
    (server, operations)
}

#[tokio::test]
async fn reapplying_authentication_refuses_a_changed_or_missing_range_and_creates_nothing() {
    for (change, annotations, missing) in [
        (
            "the UID range changed",
            json!({UID_RANGE: "1000700000/10000", GROUP_RANGE: "1000690000/10000"}),
            false,
        ),
        (
            "the group range changed",
            json!({UID_RANGE: "1000680000/10000", GROUP_RANGE: "1000700000/10000"}),
            false,
        ),
        (
            "the group-range annotation was removed, so the group follows the UID",
            json!({UID_RANGE: "1000680000/10000"}),
            false,
        ),
        ("the range annotations were removed", json!({}), true),
    ] {
        let objects = platform::cluster();
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("state");
        let (server, operations) = removed_authentication(&objects, &state).await;
        platform::annotate_namespace(&objects, annotations);
        let before = Snapshot::capture(&objects, &state);
        let (requests, writes) = (server.requests().len(), server.mutations().len());

        let result = operations
            .ensure(&platform::spec_on(AUTH_KIND, "openshift"), None)
            .await;

        let seen = server.requests()[requests..].to_vec();
        // A changed range is a binding mismatch; a missing one is a backend
        // error whose hint names the UID range.
        let refused = match &result {
            Err(ObservationError::BindingMismatch) => !missing,
            Err(ObservationError::Backend(hint)) => missing && hint.contains("UID range"),
            _ => false,
        };
        assert!(
            refused,
            "re-applying after {change}: {result:?}, requests: {seen:?}"
        );
        assert_eq!(
            server.mutations().len(),
            writes,
            "mutating requests after {change}: {:?}",
            &server.mutations()[writes..]
        );
        before.assert_unchanged(&objects, &state, &format!("after {change}"));
    }
}

#[tokio::test]
async fn reapplying_authentication_recreates_the_issuer_when_the_ranges_are_unchanged() {
    let objects = platform::cluster();
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let (server, operations) = removed_authentication(&objects, &state).await;
    let writes = server.mutations().len();

    let result = operations
        .ensure(&platform::spec_on(AUTH_KIND, "openshift"), None)
        .await;

    // Control for the refusals above: the same removed state is accepted when
    // only the ranges are left as recorded.
    assert_eq!(
        result.map(|response| response.running),
        Ok(Some(true)),
        "requests: {:?}",
        server.requests()
    );
    let created = &server.mutations()[writes..];
    assert!(
        !created.is_empty() && created.iter().all(|(method, _)| method == "POST"),
        "the issuer objects were not created: {created:?}"
    );
}
