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

fn object(address: &str, id: &str) -> serde_json::Value {
    serde_json::json!({"address":address, "mode":"managed", "values":{"id":id}})
}
fn state(resources: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"format_version":"1.0", "values":{"root_module":{"resources":resources}}})
}
fn read(value: &serde_json::Value) -> Result<BTreeMap<String, StateBinding>, Error> {
    parse_bindings(&serde_json::to_vec(value).unwrap())
}
#[test]
fn documented_state_json_preserves_full_instance_addresses() {
    let mut value = state(serde_json::json!([
        object("docker_container.agent[\"one\"]", "first"),
        object("docker_container.agent[\"two\"]", "second")
    ]));
    value["values"]["root_module"]["child_modules"] = serde_json::json!([
        {"address":"module.workload", "resources":[object("module.workload.docker_container.agent", "nested")]}
    ]);
    let observed = read(&value).unwrap();
    assert_eq!(observed.len(), 3);
    assert_eq!(observed["docker_container.agent[\"one\"]"].id, "first");
    assert_eq!(
        observed["module.workload.docker_container.agent"].id,
        "nested"
    );
    assert!(!observed.contains_key("docker_container.agent"));
}
#[test]
fn data_observations_do_not_become_managed_bindings() {
    let data = serde_json::json!({"address":"data.example.observed", "mode":"data", "values":{"id":"observation"}});
    let value = state(serde_json::json!([
        object("nemoclaw_workspace.deployment", "owned"),
        data,
        {"address":crate::compile::GATEWAY_CAPABILITIES_ADDRESS, "mode":"data", "values":{"compatible":true}},
        {"address":crate::compile::GATEWAY_APPLY_CAPABILITIES_ADDRESS, "mode":"data", "values":{"compatible":true}}
    ]));
    let observed = read(&value).unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed["nemoclaw_workspace.deployment"].id, "owned");
}
#[test]
fn malformed_duplicate_and_unsupported_state_is_not_empty() {
    let owned = object("nemoclaw_workspace.deployment", "owned");
    for value in [
        serde_json::json!({}),
        serde_json::json!({"format_version":"2.0"}),
        state(serde_json::json!([owned, owned])),
        state(serde_json::json!([object(
            "nemoclaw_workspace.deployment",
            ""
        )])),
        state(serde_json::json!([{"address":"x.y", "mode":"unknown", "values":{"id":"x"}}])),
        state(serde_json::json!([{"address":"x.y", "mode":"managed", "values":null}])),
        state(
            serde_json::json!([{"address":"x.y", "mode":"managed", "values":{"id":"x"}, "deposed_key":""}]),
        ),
    ] {
        assert!(read(&value).is_err(), "{value}");
    }
    assert!(
        read(&serde_json::json!({"format_version":"1.0"}))
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; local OpenTofu builtin resources only"]
async fn native_state_json_preserves_module_and_instance_identity_without_refresh() {
    let bundle = crate::bundle::Bundle::open(&std::path::PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("explicit verified bundle"),
    ))
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::create_dir(root.join("child")).unwrap();
    fs::write(root.join("providers.tfrc"), "").unwrap();
    fs::write(
        root.join("main.tf.json"),
        serde_json::json!({
            "module":{"child":{"source":"./child"}},
            "resource":{"terraform_data":{"root":{"input":"retained"}}}
        })
        .to_string(),
    )
    .unwrap();
    fs::write(root.join("child/main.tf.json"), serde_json::json!({
        "resource":{"terraform_data":{"replica":{"for_each":{"a":"first","b":"second"},"input":"${each.value}"}}}
    }).to_string()).unwrap();
    let cancel = crate::CancellationToken::new();
    for args in [
        vec!["init", "-input=false"],
        vec!["apply", "-auto-approve", "-input=false"],
    ] {
        crate::process::run(
            root,
            &bundle.tofu(),
            &args,
            &schema_environment(root),
            &cancel,
        )
        .await
        .unwrap();
    }
    let path = root.join("terraform.tfstate");
    let before = fs::read(&path).unwrap();
    let observed = bindings(root, &bundle.tofu(), &cancel).await.unwrap();
    assert_eq!(observed.len(), 3);
    assert!(observed.contains_key("terraform_data.root"));
    assert_ne!(
        observed["module.child.terraform_data.replica[\"a\"]"].id,
        observed["module.child.terraform_data.replica[\"b\"]"].id
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        before,
        "inspection must not rewrite state"
    );
    fs::write(&path, b"broken").unwrap();
    assert!(bindings(root, &bundle.tofu(), &cancel).await.is_err());
    assert_eq!(fs::read(path).unwrap(), b"broken");
}

#[test]
fn replacement_cleanup_keeps_current_and_deposed_objects_distinct() {
    let address = "docker_container.runtime";
    let current = object(address, "current");
    let mut old = object(address, "old");
    old["deposed_key"] = serde_json::json!("deadbeef");
    let observed = read(&state(serde_json::json!([old, current]))).unwrap();
    assert_eq!(observed[address].id, "current");
    assert_eq!(observed[address].deposed["deadbeef"], "old");
    // The second instance is a recorded cleanup task, not a duplicate address.
    assert!(read(&state(serde_json::json!([old]))).is_ok());
    assert!(read(&state(serde_json::json!([old, old]))).is_err());
    let mut duplicate = old.clone();
    duplicate["values"]["id"] = serde_json::json!("current");
    assert!(read(&state(serde_json::json!([current, duplicate]))).is_err());
}
