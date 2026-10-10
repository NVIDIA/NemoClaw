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
    let binding = br#"{"resources":[{"type":"openshell_workspace","name":"deployment","instances":[{"attributes":{"id":"owned"}}]}]}"#;
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
fn native_helm_state_preserves_its_namespace_and_immutable_chart_binding() {
    let address = "helm_release.gateway";
    let chart = crate::kubernetes::gateway::CHART;
    let resource = serde_json::json!({
        "address": address, "mode": "managed",
        "values": {"id":"nc-owned", "name":"nc-owned", "namespace":"owned-agents", "chart":chart}
    });
    let observed = read(&state(serde_json::json!([resource]))).unwrap();
    let binding = &observed[address];
    assert_eq!(binding.id, "nc-owned");
    assert_eq!(binding.name, "nc-owned");
    assert_eq!(binding.namespace, "owned-agents");
    assert_eq!(binding.chart, chart);
    assert!(
        binding.spec.is_empty(),
        "native Helm state has no NemoClaw spec"
    );
    for field in ["namespace", "chart"] {
        let mut invalid = resource.clone();
        invalid["values"][field] = serde_json::json!(7);
        assert!(read(&state(serde_json::json!([invalid]))).is_err());
    }
    let other = read(&state(serde_json::json!([object(
        "docker_container.runtime",
        "container"
    )])))
    .unwrap();
    assert!(other["docker_container.runtime"].namespace.is_empty());
    assert!(other["docker_container.runtime"].chart.is_empty());
}
#[test]
fn data_observations_do_not_become_managed_bindings() {
    let data = serde_json::json!({"address":"data.example.observed", "mode":"data", "values":{"id":"observation"}});
    let value = state(serde_json::json!([
        object("openshell_workspace.deployment", "owned"),
        data,
        {"address":crate::compile::GATEWAY_CAPABILITIES_ADDRESS, "mode":"data", "values":{"compatible":true}},
        {"address":crate::compile::GATEWAY_APPLY_CAPABILITIES_ADDRESS, "mode":"data", "values":{"compatible":true}}
    ]));
    let observed = read(&value).unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed["openshell_workspace.deployment"].id, "owned");
}
#[test]
fn malformed_duplicate_and_unsupported_state_is_not_empty() {
    let owned = object("openshell_workspace.deployment", "owned");
    for value in [
        serde_json::json!({}),
        serde_json::json!({"format_version":"2.0"}),
        state(serde_json::json!([owned, owned])),
        state(serde_json::json!([object(
            "openshell_workspace.deployment",
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

#[test]
fn runtime_reconciliation_does_not_clear_unfinished_openshell_recovery() {
    let document = crate::config::Document::parse(
        include_bytes!("../../tests/fixtures/config/spark.yaml").as_slice(),
    )
    .unwrap();
    let mut record = Record::new(document).unwrap();
    record.begin_runtime_apply(&record.document.clone());
    assert!(record.pending && record.runtime_pending);
    record.finish_runtime_apply();
    assert!(!record.pending && !record.runtime_pending);
    let target = crate::compile::targets(&record.document, &record.generations)
        .unwrap()
        .remove(0);
    record.begin_apply(
        &record.document.clone(),
        [(target.address, target.values)].into(),
    );
    record.begin_runtime_apply(&record.document.clone());
    assert!(!record.runtime_pending);
    record.finish_runtime_apply();
    assert!(record.pending && !record.runtime_pending);
}

#[test]
fn pending_creation_guards_only_unresolved_targets_and_survives_runtime_recovery() {
    let document =
        Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    let mut record = Record::new(document.clone()).unwrap();
    let targets = crate::compile::targets(&document, &record.generations).unwrap();
    let pending = targets
        .iter()
        .find(|target| target.kind == "sandbox")
        .unwrap();
    record.pending = true;
    record.pending_creations = [(pending.address.clone(), pending.values.clone())].into();
    let mut revised = document.clone();
    let mut unrelated = revised.spec.inference_providers[0].clone();
    unrelated.name = "unrelated".into();
    revised.spec.inference_providers.push(unrelated);
    assert!(record.validate_pending_intent(&revised).is_ok());
    revised.spec.sandboxes[0].image.ref_ =
        format!("example.invalid/changed@sha256:{}", "b".repeat(64));
    revised.validate().unwrap();
    assert!(matches!(
        record.validate_pending_intent(&revised),
        Err(Error::Conflict(_))
    ));
    revised.spec.sandboxes[0].name = "replacement".into();
    revised.validate().unwrap();
    assert!(matches!(
        record.validate_pending_intent(&revised),
        Err(Error::Conflict(_))
    ));
    record.begin_runtime_apply(&record.document.clone());
    record.finish_runtime_apply();
    assert!(record.pending && !record.runtime_pending);
    assert_eq!(record.pending_creations[&pending.address], pending.values);
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    store.save(&record).unwrap();
    assert_eq!(store.load().unwrap().unwrap(), record);
}

#[test]
fn subsequent_apply_preserves_all_unresolved_creations_until_success() {
    let document =
        Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    let mut record = Record::new(document.clone()).unwrap();
    let targets = crate::compile::targets(&document, &record.generations).unwrap();
    let first = &targets[0];
    let second = &targets[1];
    record.begin_apply(
        &document,
        [(first.address.clone(), first.values.clone())].into(),
    );
    record.begin_apply(
        &document,
        [(second.address.clone(), second.values.clone())].into(),
    );
    assert_eq!(record.pending_creations.len(), 2);
    record.begin_apply(&document, BTreeMap::new());
    assert!(record.pending && !record.runtime_pending);
    assert_eq!(record.pending_creations.len(), 2);
    record.finish_apply();
    assert!(!record.pending && record.pending_creations.is_empty());
    record.begin_apply(&document, BTreeMap::new());
    assert!(!record.pending && !record.runtime_pending);
    assert!(record.validate_pending_intent(&document).is_ok());
}

#[test]
fn applying_only_bound_resources_does_not_require_creation_recovery() {
    let document =
        Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    let mut record = Record::new(document.clone()).unwrap();
    record.begin_apply(&document, BTreeMap::new());
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    store.save(&record).unwrap();
    let recovered = store.load().unwrap().unwrap();
    assert!(
        !recovered.pending,
        "OpenTofu already owns every planned resource binding"
    );
    assert!(!recovered.runtime_pending);
    assert!(recovered.pending_creations.is_empty());
}

fn assert_rejected_record_preserves_state(value: serde_json::Value) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    let intent = directory.path().join("intent.json");
    let resources = directory.path().join("terraform.tfstate");
    let bytes = serde_json::to_vec(&value).unwrap();
    let binding = br#"{"resources":[{"type":"openshell_workspace","name":"deployment","instances":[{"attributes":{"id":"owned"}}]}]}"#;
    fs::write(&intent, &bytes).unwrap();
    fs::write(&resources, binding).unwrap();
    assert!(
        store.load().is_err(),
        "unsupported record was accepted: {value}"
    );
    assert_eq!(fs::read(intent).unwrap(), bytes);
    assert_eq!(fs::read(resources).unwrap(), binding);
}

#[test]
fn pending_creation_requires_current_per_resource_evidence() {
    let document =
        Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    let mut record = Record::new(document.clone()).unwrap();
    let target = crate::compile::targets(&document, &record.generations)
        .unwrap()
        .remove(0);
    record.begin_apply(&document, [(target.address, target.values)].into());
    let mut missing = serde_json::to_value(&record).unwrap();
    missing.as_object_mut().unwrap().remove("pendingCreations");
    assert_rejected_record_preserves_state(missing.clone());
    for evidence in [
        serde_json::Value::Null,
        serde_json::json!({}),
        serde_json::json!("invalid"),
        serde_json::json!({"openshell_sandbox.unknown": {}}),
    ] {
        let mut malformed = missing.clone();
        malformed["pendingCreations"] = evidence;
        assert_rejected_record_preserves_state(malformed);
    }
}

#[test]
fn malformed_or_unknown_generations_are_rejected_without_rewriting_state() {
    let document =
        Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    let record = serde_json::to_value(Record::new(document).unwrap()).unwrap();
    for (kind, value) in [
        ("workspace", serde_json::json!("not-a-generation")),
        ("managed_gateway", serde_json::json!("")),
        ("unsupported_service", serde_json::json!("a".repeat(32))),
    ] {
        let mut malformed = record.clone();
        malformed["generations"][kind] = value;
        assert_rejected_record_preserves_state(malformed);
    }
}

/// A managed Kubernetes deployment's two resource kinds get generations and
/// survive a save and reload, like every other kind.
#[test]
fn a_kubernetes_records_generations_reload_and_stay_stable() {
    let mut value = serde_json::to_value(
        Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap(),
    )
    .unwrap();
    value["spec"]["gateway"] = serde_json::json!({
        "management": "managed", "runtime": {"provider": "kubernetes"},
        "endpoint": "https://127.0.0.1:17671",
        "kubernetes": {
            "kubeconfig": {"env": "TEST_KUBECONFIG"}, "context": "test-cluster",
            "namespace": "test-agents", "authentication": {"profile": "development"}
        }
    });
    value["spec"]["sandboxes"][0]["image"]["metadata"] =
        serde_json::json!({"env": "TEST_IMAGE_METADATA"});
    let document = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
    let mut record = Record::new(document.clone()).unwrap();
    for kind in [
        crate::kubernetes::GATEWAY_KIND,
        crate::kubernetes::STORAGE_KIND,
    ] {
        assert_eq!(record.generations[kind].len(), 32, "{kind}");
    }
    let generations = record.generations.clone();
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    store.save(&record).unwrap();
    let mut reloaded = store.load().unwrap().unwrap();
    reloaded.allocate_missing_generations(&document).unwrap();
    assert_eq!(reloaded.generations, generations);
    record.allocate_missing_generations(&document).unwrap();
    assert_eq!(record.generations, generations);
}

#[test]
fn adding_a_service_allocates_one_generation_and_preserves_checkpoint_identity() {
    let mut document =
        Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    let managed = Document::parse(
        include_bytes!("../../tests/fixtures/config/managed-ollama.yaml").as_slice(),
    )
    .unwrap();
    document.spec.gateway = managed.spec.gateway.clone();
    let mut record = Record::new(document.clone()).unwrap();
    let original = record.generations.clone();
    document.spec.services = managed.spec.services;

    record.allocate_missing_generations(&document).unwrap();
    assert_eq!(record.generations.len(), original.len() + 1);
    for (kind, generation) in original {
        assert_eq!(record.generations[&kind], generation);
    }
    let added = record.generations["ollama_service"].clone();
    assert_eq!(added.len(), 32);
    assert!(
        added
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );

    record.allocate_missing_generations(&document).unwrap();
    let generations = record.generations.clone();
    record.begin_runtime_apply(&document);
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    store.save(&record).unwrap();
    let mut recovered = store.load().unwrap().unwrap();
    assert_eq!(recovered.generations, generations);
    recovered.finish_runtime_apply();
    recovered.begin_apply(&document, BTreeMap::new());
    store.save(&recovered).unwrap();
    let mut recovered = store.load().unwrap().unwrap();
    assert_eq!(recovered.generations, generations);
    recovered.allocate_missing_generations(&document).unwrap();
    recovered.begin_apply(&document, BTreeMap::new());
    store.save(&recovered).unwrap();
    let mut recovered = store.load().unwrap().unwrap();
    assert_eq!(recovered.generations, generations);

    document.spec.services.clear();
    recovered.begin_apply(&document, BTreeMap::new());
    store.save(&recovered).unwrap();
    assert_eq!(store.load().unwrap().unwrap().generations, generations);
}

#[test]
fn runtime_pending_without_a_runtime_is_rejected_without_rewriting_state() {
    let document =
        Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    assert!(!document.has_runtime());
    let mut value = serde_json::to_value(Record::new(document).unwrap()).unwrap();
    value["pending"] = serde_json::json!(true);
    value["runtimePending"] = serde_json::json!(true);
    assert_rejected_record_preserves_state(value);
}

#[test]
fn recovery_checkpoints_survive_reload_and_reapply() {
    let document =
        Document::parse(include_bytes!("../../tests/fixtures/config/spark.yaml").as_slice())
            .unwrap();
    let mut record = Record::new(document.clone()).unwrap();
    let generations = record.generations.clone();
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    record.begin_runtime_apply(&document);
    store.save(&record).unwrap();
    record = store.load().unwrap().unwrap();
    assert!(record.pending && record.runtime_pending);
    assert!(!record.succeeded);
    record.finish_runtime_apply();
    record.begin_apply(&document, BTreeMap::new());
    record.finish_apply();
    assert!(!record.pending && !record.succeeded);
    store.save(&record).unwrap();
    record = store.load().unwrap().unwrap();
    assert!(
        !record.pending && !record.succeeded,
        "settled mutations do not imply healthy completion"
    );
    record.mark_succeeded();
    store.save(&record).unwrap();
    record = store.load().unwrap().unwrap();
    assert!(record.succeeded);
    record.begin_destroy();
    store.save(&record).unwrap();
    record = store.load().unwrap().unwrap();
    assert!(record.destroying && !record.succeeded && !record.destroy_runtime);
    record.finish_root_destroy();
    store.save(&record).unwrap();
    record = store.load().unwrap().unwrap();
    record.begin_destroy();
    assert!(
        record.destroy_runtime,
        "retry must retain the completed root stage"
    );
    record.finish_destroy();
    store.save(&record).unwrap();
    record = store.load().unwrap().unwrap();
    assert!(record.destroyed && !record.destroying && !record.pending && !record.runtime_pending);
    record.begin_apply(&document, BTreeMap::new());
    assert!(!record.destroyed && !record.destroy_runtime && !record.succeeded);
    assert_eq!(record.generations, generations);
    assert_eq!(record.document, document);
    assert_eq!(record.digest, document.digest());
    store.save(&record).unwrap();
    assert_eq!(store.load().unwrap().unwrap(), record);
}

#[test]
fn teardown_takes_over_interrupted_runtime_recovery_without_losing_its_checkpoint() {
    let document =
        Document::parse(include_bytes!("../../tests/fixtures/config/spark.yaml").as_slice())
            .unwrap();
    let mut record = Record::new(document.clone()).unwrap();
    record.begin_runtime_apply(&document);
    record.begin_destroy();
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    store.save(&record).unwrap();
    record = store.load().unwrap().unwrap();
    assert!(record.destroying && !record.pending && !record.succeeded);
    record.finish_root_destroy();
    store.save(&record).unwrap();
    record = store.load().unwrap().unwrap();
    assert!(record.root_destroyed());
    record.finish_destroy();
    assert!(!record.runtime_pending && record.pending_creations.is_empty());
    store.save(&record).unwrap();
    assert_eq!(store.load().unwrap().unwrap(), record);
}

#[test]
fn pending_recovery_requires_matching_current_bindings_and_retains_unknown_creations() {
    let document =
        Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    let mut record = Record::new(document.clone()).unwrap();
    let targets = crate::compile::targets(&document, &record.generations).unwrap();
    let pending: BTreeMap<_, _> = targets
        .iter()
        .map(|target| (target.address.clone(), target.values.clone()))
        .collect();
    record.begin_apply(&document, pending);
    let mut bindings: BTreeMap<_, _> = targets
        .iter()
        .filter(|target| target.kind != "agent_configuration")
        .map(|target| {
            let get = |key: &str| target.values.get(key).cloned().unwrap_or_default();
            (
                target.address.clone(),
                StateBinding {
                    id: format!("id-{}", target.address),
                    name: get("name"),
                    workspace: get("workspace"),
                    owner: get("owner"),
                    generation: get("generation"),
                    ..Default::default()
                },
            )
        })
        .collect();
    let sandbox = "openshell_sandbox.assistant";
    for field in ["id", "name", "workspace", "owner", "generation"] {
        let mut mismatched = bindings.clone();
        let binding = mismatched.get_mut(sandbox).unwrap();
        match field {
            "id" => {
                binding.deposed.insert("old".into(), binding.id.clone());
                binding.id.clear();
            }
            "name" => binding.name = "other".into(),
            "workspace" => binding.workspace = "other".into(),
            "owner" => binding.owner = "other".into(),
            "generation" => binding.generation = "other".into(),
            _ => unreachable!(),
        }
        let mut retained = record.clone();
        retained.reconcile_pending_creations(&mismatched);
        assert!(retained.pending(), "{field}");
        let unresolved = retained.pending_creations;
        assert!(unresolved.contains_key(sandbox));
        assert!(unresolved.contains_key("fabric_agent_configuration.assistant"));
    }
    let missing = bindings
        .keys()
        .find(|address| address.starts_with("openshell_provider_profile."))
        .unwrap()
        .clone();
    bindings.remove(&missing);
    record.reconcile_pending_creations(&bindings);
    assert_eq!(
        record.pending_creations.keys().collect::<Vec<_>>(),
        [&missing]
    );
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    store.save(&record).unwrap();
    assert_eq!(store.load().unwrap().unwrap(), record);
    let desired = &record.pending_creations[&missing];
    bindings.insert(
        missing.clone(),
        StateBinding {
            id: "saved-profile".into(),
            name: desired["name"].clone(),
            workspace: desired["workspace"].clone(),
            owner: desired["owner"].clone(),
            generation: desired["generation"].clone(),
            ..Default::default()
        },
    );
    record.reconcile_pending_creations(&bindings);
    assert!(!record.pending());
    assert!(record.pending_creations.is_empty());
}

#[test]
fn bound_sandbox_guard_allows_configuration_updates_additions_and_explicit_recreation() {
    let document =
        Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    let record = Record::new(document.clone()).unwrap();
    let bound = BTreeMap::from([(
        "openshell_sandbox.assistant".into(),
        StateBinding {
            id: "saved-sandbox".into(),
            ..Default::default()
        },
    )]);
    let mut revised = document.clone();
    revised.metadata.name = "new-display-name".into();
    revised.spec.sandboxes[0]
        .agent
        .inference
        .as_mut()
        .unwrap()
        .routes[0]
        .overrides
        .model = "corrected-model".into();
    let mut added = revised.spec.sandboxes[0].clone();
    added.name = "reviewer".into();
    revised.spec.sandboxes.push(added);
    revised.spec.sandboxes.reverse();
    record.validate_bound_sandboxes(&revised, &bound).unwrap();
    for change in ["remove", "image", "agent", "policy", "endpoint"] {
        let mut value = serde_json::to_value(&document).unwrap();
        match change {
            "remove" => value["spec"]["sandboxes"][0]["name"] = serde_json::json!("different"),
            "image" => {
                value["spec"]["sandboxes"][0]["image"]["ref"] =
                    serde_json::json!(format!("sandbox@sha256:{}", "f".repeat(64)))
            }
            "agent" => {
                value["spec"]["sandboxes"][0]["agent"]["name"] = serde_json::json!("different")
            }
            "policy" => {
                value["spec"]["sandboxes"][0]["network"] =
                    serde_json::json!({"policy":{"explicit":{"version":1,"network_policies":{}}}})
            }
            "endpoint" => {
                value["spec"]["inferenceProviders"][0]["endpoint"] =
                    serde_json::json!("http://127.0.0.1:19999/v1")
            }
            _ => unreachable!(),
        }
        let changed = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
        let error = record
            .validate_bound_sandboxes(&changed, &bound)
            .unwrap_err();
        assert!(
            matches!(error, Error::SandboxChangeRefused { ref sandbox, .. } if sandbox == "assistant")
        );
        // No bound sandbox remains after explicit teardown, so a new workload
        // may use the retained workspace with a revised launch specification.
        record
            .validate_bound_sandboxes(&changed, &BTreeMap::new())
            .unwrap();
    }
}

#[test]
fn typed_storage_bindings_compare_their_complete_identity() {
    let values = serde_json::json!({
        "id":"engine/nc-0123456789abcdef-inference-qwen-auth/created",
        "name":"nc-0123456789abcdef-inference-qwen-auth",
        "owner":"302ff5e1-088d-42ce-959f-4ff4c3570c13",
        "generation":"b".repeat(32),
        "engine":"unix:///var/run/docker.sock",
    });
    let address = "nemoclaw_inference_storage.inference_qwen_auth";
    let bindings = read(&state(serde_json::json!([
        {"address":address, "mode":"managed", "values":values}
    ])))
    .unwrap();
    let compiled: crate::backend::Row = serde_json::from_value(values.clone()).unwrap();
    assert!(!bindings[address].differs(&compiled));
    for attribute in ["name", "owner", "generation", "engine"] {
        let mut changed = compiled.clone();
        changed.insert(attribute.into(), "changed".into());
        assert!(bindings[address].differs(&changed), "{attribute}");
    }
}

#[test]
fn gateway_storage_bindings_record_their_typed_settings() {
    // Docker gateway storage omits its endpoint, which state records as null.
    let values = serde_json::json!({
        "id":"engine/nc-0123456789abcdef-gateway-data/created",
        "name":"nc-0123456789abcdef-gateway",
        "owner":"302ff5e1-088d-42ce-959f-4ff4c3570c13",
        "generation":"b".repeat(32),
        "compute_driver":"docker",
        "engine":"unix:///var/run/docker.sock",
        "endpoint":null,
        "image":format!("gateway@sha256:{}", "a".repeat(64)),
        "network_cidr":"172.30.160.0/24",
        "image_pull_policy":null,
        "data_path":"/var/lib/docker/volumes/data/_data",
    });
    let address = "nemoclaw_gateway_storage.runtime";
    let bindings = read(&state(serde_json::json!([
        {"address":address, "mode":"managed", "values":values}
    ])))
    .unwrap();
    let compiled: crate::backend::Row = values
        .as_object()
        .unwrap()
        .iter()
        .filter(|(name, _)| crate::managed::GATEWAY_ATTRIBUTES.contains(&name.as_str()))
        .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned())))
        .collect();
    assert_eq!(bindings[address].typed_values(), compiled);
    assert!(!bindings[address].differs(&compiled));
    let mut changed = compiled.clone();
    changed.insert("image".into(), "changed".into());
    assert!(bindings[address].differs(&changed));
}
