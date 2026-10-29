// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A deployment's receipt records its namespace by UID and binds one owner.

use nemoclaw_sdk::{
    ObservationError,
    kubernetes::{cluster::Owned, receipt::Receipt},
};

#[test]
fn a_receipt_survives_a_save_with_its_bound_namespace() {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(
        Receipt::load(directory.path(), "owner-1", "nc-1-gateway").unwrap(),
        None
    );
    let mut receipt = Receipt::new("owner-1", "nc-1-gateway");
    receipt.namespace = Some(Owned {
        api_version: "v1".into(),
        kind: "Namespace".into(),
        namespace: String::new(),
        name: "agents".into(),
        uid: "namespace-1".into(),
    });
    receipt.save(directory.path()).unwrap();
    assert_eq!(
        Receipt::load(directory.path(), "owner-1", "nc-1-gateway").unwrap(),
        Some(receipt)
    );
}

#[test]
fn another_deployments_receipt_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    Receipt::new("owner-1", "nc-1-gateway")
        .save(directory.path())
        .unwrap();
    assert!(matches!(
        Receipt::load(directory.path(), "owner-2", "nc-1-gateway"),
        Err(ObservationError::BindingMismatch)
    ));
}
