// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A corrupt receipt is never replaced or deleted by a Kubernetes operation.
//!
//! The receipt is the only record of which cluster objects a deployment owns,
//! so overwriting an unreadable one would orphan every object it recorded.
//! When the file is not valid JSON or holds a field the receipt does not
//! define, every operation that reads it must report an incomplete observation,
//! keep the file byte for byte, and send the cluster no write. A missing
//! receipt, an older receipt that still parses, and a receipt written for
//! another deployment are not covered.
#![cfg(unix)]

use crate::kube_faults::{
    Snapshot,
    platform::{self, Call, NAME, OWNER, assert_class, run},
    serve,
};
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::{AUTH_KIND, GATEWAY_KIND, STORAGE_KIND},
};

/// Put `receipt` in the state directory and make every call that reads it.
/// Removing storage is refused before any receipt is read, so it is not a case.
async fn assert_every_operation_refuses(receipt: &str) {
    let objects = platform::cluster();
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(state.join("receipt.json"), receipt).unwrap();
    let before = Snapshot::capture(&objects, &state);
    let server = serve(&objects, |_, _, _| None).await;
    let operations = platform::operations(server.client(), server.endpoint(), &state);

    let calls = [STORAGE_KIND, AUTH_KIND, GATEWAY_KIND]
        .into_iter()
        .flat_map(|kind| {
            [
                Call::Read(kind),
                Call::ReadForRemoval(kind),
                Call::Ensure(kind),
                Call::Remove(kind),
            ]
        })
        .filter(|call| !matches!(call, Call::Remove(STORAGE_KIND)))
        .chain([Call::Connect]);
    for call in calls {
        let result = run(&operations, "kubernetes", call).await;

        let context = format!(
            "{call:?} over a corrupt receipt, requests: {:?}",
            server.requests()
        );
        assert_class(&result, &[ObservationError::Incomplete], &context);
        assert!(
            server.mutations().is_empty(),
            "{context}: sent writes {:?}",
            server.mutations()
        );
        before.assert_unchanged(&objects, &state, &context);
    }
}

#[tokio::test]
async fn an_invalid_json_receipt_fails_every_operation_that_reads_it_as_incomplete_and_stays_untouched()
 {
    // A receipt cut off partway through an object entry.
    let truncated = format!(
        r#"{{"owner":"{OWNER}","name":"{NAME}","objects":[{{"apiVersion":"v1","kind":"Namespace","na"#
    );
    assert_every_operation_refuses(&truncated).await;
}

#[tokio::test]
async fn a_receipt_with_an_unknown_field_fails_every_operation_that_reads_it_as_incomplete_and_stays_untouched()
 {
    // Valid for this deployment in every other respect.
    let unknown = format!(r#"{{"owner":"{OWNER}","name":"{NAME}","unexpected":true}}"#);
    assert_every_operation_refuses(&unknown).await;
}
