// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

const GATEWAY: &str = "nemoclaw_managed_gateway.runtime";

fn context() -> (Document, crate::compile::Generations) {
    let document =
        Document::parse(include_bytes!("../../../../../examples/spark/vllm.yaml").as_slice())
            .unwrap();
    let generations = Record::new(document.clone()).unwrap().generations;
    (document, generations)
}

fn gateway_targets() -> (Spec, Vec<Target>) {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("../../managed/reference.json")).unwrap();
    let mut spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    spec.gateway.network_cidr = "172.30.161.0/24".into();
    let mut targets = Vec::new();
    for (kind, address, layout) in [
        (GATEWAY_STORAGE_KIND, GATEWAY_STORAGE, 0),
        (GATEWAY_KIND, GATEWAY, 2),
    ] {
        spec.layout = layout;
        targets.push(Target {
            kind: kind.into(),
            address: address.into(),
            values: [("spec".into(), spec.json().unwrap())].into(),
        });
    }
    (spec, targets)
}

#[test]
fn replacement_and_gateway_deferral_use_refreshed_plan_observations() {
    let (document, generations) = context();
    let (_, mut targets) = gateway_targets();
    let bindings: BTreeMap<String, StateBinding> = targets
        .iter()
        .map(|target| {
            (
                target.address.clone(),
                StateBinding {
                    id: format!("physical-{}", target.kind),
                    spec: target.values["spec"].clone(),
                },
            )
        })
        .collect();
    let mut want: Spec = serde_json::from_str(&targets[1].values["spec"]).unwrap();
    want.gateway.endpoint = "http://127.0.0.1:17682".into();
    targets[1]
        .values
        .insert("spec".into(), want.json().unwrap());
    let changes: Vec<Value> = targets.iter().map(|target| json!({
        "address": target.address,
        "change": {
            "actions": if target.kind == GATEWAY_KIND { vec!["delete", "create"] } else { vec!["no-op"] },
            "before": {"id": bindings[&target.address].id, "spec": bindings[&target.address].spec, "running": "true"}
        }
    })).collect();
    let mut plan: Plan = serde_json::from_value(json!({"resource_changes": changes})).unwrap();
    let checked =
        runtime_observations(&document, &generations, &targets, &bindings, &plan).unwrap();
    assert!(checked.gateway_running);
    assert!(checked.replacements.contains(GATEWAY));
    assert_eq!(
        check_runtime_plan(&plan, &checked.expected, &bindings, &checked.replacements)
            .unwrap()
            .len(),
        1
    );
    plan.resource_changes[1].change.before["running"] = json!("false");
    assert!(
        !runtime_observations(&document, &generations, &targets, &bindings, &plan)
            .unwrap()
            .gateway_running
    );
    for invalid in [
        json!({"actions": ["create"], "before": null}),
        json!({"actions": ["no-op"], "before": {"id": "other", "spec": bindings[GATEWAY_STORAGE].spec}}),
        json!({"actions": ["no-op"], "before": {"id": bindings[GATEWAY_STORAGE].id, "spec": "changed"}}),
    ] {
        plan.resource_changes[0].change = serde_json::from_value(invalid).unwrap();
        let checked =
            runtime_observations(&document, &generations, &targets, &bindings, &plan).unwrap();
        assert!(checked.replacements.is_empty());
        assert!(
            check_runtime_plan(&plan, &checked.expected, &bindings, &checked.replacements).is_err()
        );
    }
}

#[test]
fn unbound_gateway_is_deferred_and_retained_intent_is_checked_locally() {
    let (document, generations) = context();
    let (_, targets) = gateway_targets();
    let plan: Plan = serde_json::from_value(
        json!({"resource_changes": targets.iter().map(|target| json!({
        "address": target.address, "change": {"actions": ["create"], "before": null}
    })).collect::<Vec<_>>()}),
    )
    .unwrap();
    let checked =
        runtime_observations(&document, &generations, &targets, &BTreeMap::new(), &plan).unwrap();
    assert!(!checked.gateway_running);
    assert_eq!(
        check_runtime_plan(
            &plan,
            &checked.expected,
            &BTreeMap::new(),
            &checked.replacements
        )
        .unwrap()
        .len(),
        2
    );
    let mut bindings = BTreeMap::from([(
        GATEWAY_STORAGE.into(),
        StateBinding {
            id: "storage".into(),
            spec: "changed".into(),
        },
    )]);
    assert!(runtime_bindings(&targets, &bindings).is_err());
    bindings.clear();
    bindings.insert("undeclared".into(), StateBinding::default());
    assert!(runtime_bindings(&targets, &bindings).is_err());
}

#[test]
fn native_compute_binding_does_not_require_a_nemoclaw_spec_or_replacement_authorization() {
    let target = Target {
        kind: "inference_service".into(),
        address: "docker_container.inference_service_model".into(),
        values: Row::new(),
    };
    let bindings = BTreeMap::from([(
        target.address.clone(),
        StateBinding {
            id: "prior-container".into(),
            spec: String::new(),
        },
    )]);
    let expected = runtime_bindings(std::slice::from_ref(&target), &bindings).unwrap();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address": target.address, "change":{"actions":["delete","create"],"before":{"id":"prior-container"}}}]})).unwrap();
    assert_eq!(
        check_runtime_plan(&plan, &expected, &bindings, &BTreeSet::new())
            .unwrap()
            .len(),
        1
    );
    let removed = runtime_bindings(&[], &bindings).unwrap();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address": target.address, "change":{"actions":["delete"],"before":{"id":"prior-container"}}}]})).unwrap();
    assert_eq!(
        check_runtime_plan(&plan, &removed, &bindings, &BTreeSet::new())
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn removing_the_last_runtime_cannot_orphan_retained_state() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    let stage = directory.path().join("runtime");
    fs::create_dir(&stage).unwrap();
    let state = stage.join("terraform.tfstate");
    let bytes = serde_json::to_vec(&json!({"resources":[{"type":"nemoclaw_inference_storage","name":"model","instances":[{"attributes":{"id":"daemon/volume/created","spec":"retained"}}]}]})).unwrap();
    fs::write(&state, &bytes).unwrap();
    let (document, _) = context();
    let mut record = Record::new(document).unwrap();
    let desired =
        Document::parse(include_bytes!("../../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    assert!(!desired.has_runtime());
    let bundle = Bundle {
        directory: directory.path().into(),
        manifest: crate::bundle::Manifest {
            version: "unused".into(),
            rust: "unused".into(),
            opentofu: "unused".into(),
            files: BTreeMap::new(),
        },
    };
    let deployment = Deployment::new(directory.path(), directory.path());
    assert!(
        deployment
            .runtime_stage(
                &bundle,
                &store,
                &desired,
                &mut record,
                true,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(fs::read(state).unwrap(), bytes);
}

#[test]
fn docker_gateway_plan_uses_provider_reconciliation_but_requires_durable_identity() {
    let (document, generations) = context();
    let targets = compile::runtime_targets(&document, &generations).unwrap();
    let gateway = targets
        .iter()
        .find(|target| target.kind == GATEWAY_KIND)
        .unwrap();
    let storage = targets
        .iter()
        .find(|target| target.kind == GATEWAY_STORAGE_KIND)
        .unwrap();
    let mut bindings = BTreeMap::from([(
        gateway.address.clone(),
        StateBinding {
            id: "container".into(),
            spec: String::new(),
        },
    )]);
    assert!(runtime_bindings(&targets, &bindings).is_err());
    bindings.insert(
        storage.address.clone(),
        StateBinding {
            id: "durable".into(),
            spec: storage.values["spec"].clone(),
        },
    );
    for (actions, running) in [
        (vec!["no-op"], true),
        (vec!["delete", "create"], false),
        (vec!["create"], false),
    ] {
        let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address":gateway.address,"change":{"actions":actions,"before":{"id":"container"}}}]})).unwrap();
        let observed =
            runtime_observations(&document, &generations, &targets, &bindings, &plan).unwrap();
        assert_eq!(observed.gateway_running, running);
    }
}
