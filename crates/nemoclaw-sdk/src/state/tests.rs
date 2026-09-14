// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
#[test]
fn lock_excludes_other_operations_and_atomic_intent_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert!(Store::open(dir.path()).is_err());
    assert!(store.load().unwrap().is_none());
    let document = crate::config::Document::parse(
        include_str!("../../tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    let record = Record::new(document).unwrap();
    store.save(&record).unwrap();
    assert_eq!(store.load().unwrap().unwrap(), record);
    drop(store);
    assert_eq!(
        Store::open(dir.path()).unwrap().load().unwrap().unwrap(),
        record
    );
}
#[test]
fn corrupt_intent_is_not_an_empty_deployment() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    std::fs::write(dir.path().join("intent.json"), "{broken").unwrap();
    assert!(store.load().is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("intent.json")).unwrap(),
        "{broken"
    );
}
#[test]
fn duplicate_unbound_and_multiple_instances_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let resource = serde_json::json!({"type":"nemoclaw_workspace","name":"deployment","instances":[{"attributes":{"id":"physical"}}]});
    for resources in [
        serde_json::json!([resource.clone(), resource.clone()]),
        serde_json::json!([{"type":"nemoclaw_workspace","name":"deployment","instances":[]}]),
        serde_json::json!([{"type":"nemoclaw_workspace","name":"deployment","instances":[{"attributes":{"id":""}}]}]),
    ] {
        std::fs::write(
            dir.path().join("terraform.tfstate"),
            serde_json::json!({"resources":resources}).to_string(),
        )
        .unwrap();
        assert!(store.bindings().is_err());
    }
    std::fs::write(
        dir.path().join("terraform.tfstate"),
        serde_json::json!({"resources":[resource]}).to_string(),
    )
    .unwrap();
    assert_eq!(
        store.bindings().unwrap()["nemoclaw_workspace.deployment"].id,
        "physical"
    );
}
