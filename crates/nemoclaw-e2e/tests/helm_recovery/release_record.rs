// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Destroy when Kubernetes still holds the Helm release record but OpenTofu
//! has no binding for the release.
//!
//! Without a binding, destroy cannot uninstall the release. The release may
//! still run, so the development issuer that its gateway authenticates against
//! must stay until the record is gone.

use super::*;

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn destroy_keeps_the_issuer_while_a_release_record_has_no_binding_and_finishes_once_the_record_is_gone()
 {
    // Storage and authentication are bound. The release exists only as a record
    // in the cluster, which authentication observed when it was prepared.
    let fixture = Fixture::prepare().await;
    assert_eq!(
        fixture
            .bindings()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "openshell_kubernetes_auth.runtime",
            "openshell_kubernetes_storage.runtime"
        ]
    );
    let before = fixture.snapshot();

    // Destroy stops when it reaches authentication's removal. A regression that
    // removes the issuer while the record exists sends deletes here, and
    // `assert_unchanged` reports them as writes.
    let error = fixture
        .deployment
        .destroy(&CancellationToken::new())
        .await
        .expect_err("destroy must stop while the release record exists");
    assert_execution(
        &error,
        "apply",
        &["Destroy incomplete", "observation is incomplete"],
    );
    before.assert_unchanged(&fixture, "destroy");

    // Export and apply stay refused until destroy runs again.
    fixture
        .assert_export_refused("cannot export while destroy is unfinished")
        .await;
    let error = fixture
        .deployment
        .apply(&document(), &CancellationToken::new())
        .await
        .expect_err("apply must be refused during an unfinished destroy");
    assert!(
        error
            .to_string()
            .contains("unfinished destroy; rerun destroy before another operation"),
        "{error}"
    );

    // Once Kubernetes holds no record, the same destroy removes the issuer and
    // retains storage.
    fixture.api.uninstall(&fixture.name, &fixture.namespace);
    fixture.finish().await;
}
