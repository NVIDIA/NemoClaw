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
