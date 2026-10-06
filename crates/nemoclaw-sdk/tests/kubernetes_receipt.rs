// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A deployment's receipt binds it to one cluster and one owner.

use nemoclaw_sdk::{
    ObservationError,
    kubernetes::receipt::{ClusterIdentity, Receipt},
};

fn cluster(system_uid: &str) -> ClusterIdentity {
    ClusterIdentity {
        server: "https://cluster.example:6443".into(),
        system_uid: system_uid.into(),
    }
}

#[test]
fn a_receipt_survives_a_save_and_binds_to_its_first_cluster() {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(
        Receipt::load(directory.path(), "owner-1", "nc-1-gateway").unwrap(),
        None
    );
    let mut receipt = Receipt::new("owner-1", "nc-1-gateway");
    receipt.bind(cluster("system-1")).unwrap();
    receipt.save(directory.path()).unwrap();
    let mut loaded = Receipt::load(directory.path(), "owner-1", "nc-1-gateway")
        .unwrap()
        .unwrap();
    assert_eq!(loaded, receipt);
    loaded.bind(cluster("system-1")).unwrap();
    // A rebuilt cluster at the same address has a new kube-system UID.
    assert!(matches!(
        loaded.bind(cluster("system-2")),
        Err(ObservationError::BindingMismatch)
    ));
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
