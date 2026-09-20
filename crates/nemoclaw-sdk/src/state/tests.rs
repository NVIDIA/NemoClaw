// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn gateway_capability_data_never_becomes_a_durable_resource_binding() {
    let directory = tempfile::tempdir().unwrap();
    let data = serde_json::json!({"mode":"data", "type":"nemoclaw_gateway_capabilities", "name":"current", "instances":[{"attributes":{"gateway_version":"observed", "compatible":true, "compute_drivers":["docker"], "required_compute_drivers":["docker"]}}]});
    let managed = serde_json::json!({"mode":"managed", "type":"nemoclaw_workspace", "name":"deployment", "instances":[{"attributes":{"id":"physical"}}]});
    let write = |resources| {
        std::fs::write(
            directory.path().join("terraform.tfstate"),
            serde_json::json!({"resources":resources}).to_string(),
        )
        .unwrap()
    };
    write(serde_json::json!([data, managed]));
    let observed = bindings(directory.path()).unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed["nemoclaw_workspace.deployment"].id, "physical");
    write(serde_json::json!([data, data, managed]));
    assert!(bindings(directory.path()).is_err());
    for field in ["name", "type", "module"] {
        let mut invalid = data.clone();
        invalid[field] = serde_json::json!("foreign");
        write(serde_json::json!([invalid, managed]));
        assert!(bindings(directory.path()).is_err(), "{field}");
    }
}
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
        serde_json::json!([resource, resource]),
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

#[test]
fn module_indexed_and_deposed_state_cannot_alias_a_root_binding() {
    let dir = tempfile::tempdir().unwrap();
    let ordinary = serde_json::json!({"type":"nemoclaw_workspace","name":"deployment","mode":"managed","instances":[{"attributes":{"id":"physical"}}]});
    for failure in ["module", "data", "index", "deposed"] {
        let mut resource = ordinary.clone();
        match failure {
            "module" => resource["module"] = serde_json::json!("module.foreign"),
            "data" => resource["mode"] = serde_json::json!("data"),
            "index" => resource["instances"][0]["index_key"] = serde_json::json!(0),
            _ => resource["instances"][0]["deposed"] = serde_json::json!("deadbeef"),
        }
        std::fs::write(
            dir.path().join("terraform.tfstate"),
            serde_json::json!({"resources":[resource]}).to_string(),
        )
        .unwrap();
        assert!(
            bindings(dir.path()).is_err(),
            "{failure} must not become a root binding"
        );
    }
}

#[test]
fn legacy_intent_is_rejected_without_rewriting_recovery_state() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let document = crate::config::Document::parse(
        include_str!("../../tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    let mut record = Record::new(document).unwrap();
    record.version = 6;
    let bytes = serde_json::to_vec(&record).unwrap();
    let path = dir.path().join("intent.json");
    std::fs::write(&path, &bytes).unwrap();
    assert!(store.load().is_err());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn removed_ownership_annotations_preserve_intent_and_resource_bindings_for_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let document = crate::config::Document::parse(
        include_str!("../../tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    let record = Record::new(document).unwrap();
    let mut old = serde_json::to_value(&record).unwrap();
    old["document"]["spec"]["inferenceProviders"][0]["management"] = serde_json::json!("external");
    let bytes = serde_json::to_vec(&old).unwrap();
    let intent = dir.path().join("intent.json");
    let state = dir.path().join("terraform.tfstate");
    let binding = br#"{"resources":[{"type":"nemoclaw_workspace","name":"deployment","instances":[{"attributes":{"id":"owned"}}]}]}"#;
    std::fs::write(&intent, &bytes).unwrap();
    std::fs::write(&state, binding).unwrap();
    assert!(store.load().is_err());
    assert_eq!(std::fs::read(intent).unwrap(), bytes);
    assert_eq!(std::fs::read(state).unwrap(), binding);
}

#[test]
fn capacity_data_is_discarded_without_accepting_foreign_or_duplicate_state_instances() {
    let directory = tempfile::tempdir().unwrap();
    let name = crate::services::capacity::observation_name("ssh://gpu-box");
    let data = serde_json::json!({"mode":"data", "type":"nemoclaw_service_capacity", "name":name, "instances":[{"attributes":{"engine":"ssh://gpu-box", "compatible":true}}]});
    let managed = serde_json::json!({"mode":"managed", "type":"nemoclaw_workspace", "name":"deployment", "instances":[{"attributes":{"id":"physical"}}]});
    let write = |resources| {
        std::fs::write(
            directory.path().join("terraform.tfstate"),
            serde_json::json!({"resources":resources}).to_string(),
        )
        .unwrap()
    };
    write(serde_json::json!([data, managed]));
    assert_eq!(bindings(directory.path()).unwrap().len(), 1);
    write(serde_json::json!([data, data, managed]));
    assert!(bindings(directory.path()).is_err());
    for field in ["name", "type", "module", "engine", "index", "deposed"] {
        let mut invalid = data.clone();
        match field {
            "engine" => {
                invalid["instances"][0]["attributes"]["engine"] = serde_json::json!("ssh://other")
            }
            "index" => invalid["instances"][0]["index_key"] = serde_json::json!(0),
            "deposed" => invalid["instances"][0]["deposed"] = serde_json::json!("prior"),
            _ => invalid[field] = serde_json::json!("foreign"),
        }
        write(serde_json::json!([invalid, managed]));
        assert!(bindings(directory.path()).is_err(), "{field}");
    }
}

#[test]
fn docker_state_keeps_native_ids_and_discards_local_image_observations() {
    let directory = tempfile::tempdir().unwrap();
    let state = serde_json::json!({"resources":[
        {"type":"docker_container","name":"inference_service_model","instances":[{"attributes":{"id":"container-id","name":"managed-model","labels":[]}}]},
        {"type":"docker_network","name":"network_owned","instances":[{"attributes":{"id":"network-id"}}]},
        {"type":"docker_image","name":"image_owned","instances":[{"attributes":{"id":"image-id"}}]},
        {"mode":"data","type":"docker_image","name":"image_local","instances":[{"attributes":{"id":"local-image-id","name":"model@sha256:abc"}}]}
    ]});
    std::fs::write(
        directory.path().join("terraform.tfstate"),
        state.to_string(),
    )
    .unwrap();
    let bindings = super::bindings(directory.path()).unwrap();
    assert_eq!(bindings.len(), 3);
    assert_eq!(
        bindings["docker_container.inference_service_model"].id,
        "container-id"
    );
    assert!(bindings.values().all(|binding| binding.spec.is_empty()));
}
