// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{deployment::tests::kubernetes_context, managed::GATEWAY_STORAGE_KIND};

use crate::deployment::plan::check_plan as check_runtime_plan;

const GATEWAY: &str = "openshell_podman_gateway.runtime";

/// The rows a runtime's bindings allow, after the Docker model check.
struct Checked {
    expected: BTreeMap<String, Row>,
}

fn runtime_observations(
    document: &Document,
    targets: &[Target],
    bindings: &BTreeMap<String, StateBinding>,
    plan: &Plan,
) -> Result<Checked, Error> {
    let expected = runtime_bindings(targets, bindings)?;
    preserve_docker_models(document, plan)?;
    Ok(Checked { expected })
}

#[test]
fn docker_model_updates_preserve_running_containers_unless_recreation_is_explicit() {
    for (source, name, kind) in [
        (
            include_str!("../../../../../examples/station/vllm.yaml"),
            "qwen",
            "inference_service",
        ),
        (
            include_str!("../../../../../examples/managed-ollama.yaml"),
            "ollama-server",
            "ollama_service",
        ),
        // A Podman gateway with a model placed on a Docker engine over SSH.
        (
            include_str!("../../../../../examples/spark/remote-vllm.yaml"),
            "qwen",
            "inference_service",
        ),
    ] {
        let document = Document::parse(source.as_bytes()).unwrap();
        let mut recreate = serde_json::to_value(&document).unwrap();
        recreate["spec"]["services"][name]["updatePolicy"] = json!("Recreate");
        let recreate = Document::parse(recreate.to_string().as_bytes()).unwrap();
        let record = Record::new(document.clone()).unwrap();
        let targets = compile::runtime_targets(&document, &record.generations).unwrap();
        let address = targets
            .iter()
            .find(|target| target.kind == kind)
            .unwrap()
            .address
            .clone();
        let plan = |actions: &Value, before: &Value, after: &Value| -> Plan {
            serde_json::from_value(json!({"resource_changes": [{
                "address": address,
                "change": {"actions": actions, "before": before, "after": after}
            }]}))
            .unwrap()
        };
        let refused = |plan: &Plan| {
            let message = runtime_observations(&document, &targets, &BTreeMap::new(), plan)
                .err()
                .expect("Preserve must refuse disrupting a running or unconfirmed model")
                .to_string();
            for expected in [
                name,
                "updatePolicy: Preserve",
                "updatePolicy: Recreate",
                "downtime",
            ] {
                assert!(message.contains(expected), "missing {expected}: {message}");
            }
            runtime_observations(&recreate, &targets, &BTreeMap::new(), plan).unwrap();
        };
        for actions in [
            json!(["delete", "create"]),
            json!(["create", "delete"]),
            json!(["delete"]),
        ] {
            for before in [
                json!({"id": "existing-model", "must_run": true}),
                json!({"id": "existing-model"}),
            ] {
                refused(&plan(&actions, &before, &Value::Null));
            }
        }
        // Docker lowers memory in place, and the kernel can OOM-kill a model
        // whose usage exceeds the new limit.
        for running in [
            json!({"id": "running-model", "must_run": true}),
            json!({"id": "running-model"}),
        ] {
            for (field, lowered) in [("memory", "memory_swap"), ("memory_swap", "memory")] {
                let mut before = running.clone();
                before["memory"] = json!(65536);
                before["memory_swap"] = json!(65536);
                let mut after = before.clone();
                after["must_run"] = json!(true);
                after[field] = json!(16384);
                after[lowered] = before[lowered].clone();
                refused(&plan(&json!(["update"]), &before, &after));
            }
        }
        // Provider refresh reports a stopped container as must_run=false and a
        // missing container with no prior value. A stopped model container is
        // replaced because its published port also drifts (remote_service
        // e2e). Neither requires downtime, and in-place updates that keep or
        // raise memory do not stop the model.
        let limits = |memory: u64, must_run: bool| json!({"id": "model", "must_run": must_run, "memory": memory, "memory_swap": memory});
        for (actions, before, after) in [
            (
                json!(["delete", "create"]),
                json!({"id": "stopped-model", "must_run": false}),
                Value::Null,
            ),
            (json!(["create"]), Value::Null, limits(65536, true)),
            (json!(["no-op"]), limits(65536, true), limits(65536, true)),
            (json!(["update"]), limits(65536, true), limits(65536, true)),
            (json!(["update"]), limits(16384, true), limits(65536, true)),
            (json!(["update"]), limits(65536, false), limits(16384, true)),
        ] {
            runtime_observations(
                &document,
                &targets,
                &BTreeMap::new(),
                &plan(&actions, &before, &after),
            )
            .unwrap();
        }
        // Replacement cleanup is for a previous instance, not the current model.
        let plan = serde_json::from_value(json!({"resource_changes": [{
            "address": address, "deposed": "old-instance", "change": {
                "actions": ["delete"], "before": {"id": "old-model", "must_run": true}
            }
        }, {
            "address": "docker_container.managed_gateway_runtime", "change": {
                "actions": ["delete", "create"], "before": {"id": "gateway", "must_run": true}
            }
        }, {
            "address": "docker_container.ollama_proxy_proxy", "change": {
                "actions": ["delete", "create"], "before": {"id": "proxy", "must_run": true}
            }
        }]}))
        .unwrap();
        runtime_observations(&document, &targets, &BTreeMap::new(), &plan).unwrap();
    }
}

#[test]
fn kubernetes_gateway_requires_storage_without_replacement() {
    let (document, generations) = kubernetes_context();
    let targets = compile::runtime_targets(&document, &generations).unwrap();
    let bindings = kubernetes_bindings(&targets);
    let mut plan: Plan = serde_json::from_value(json!({"resource_changes": targets.iter().map(|target| {
        let mut before = serde_json::to_value(&target.values).unwrap();
        before["id"] = json!(bindings[&target.address].id);
        before["running"] = json!("true");
        json!({"address":target.address, "change":{"actions":["no-op"], "before":before, "after":before}})
    }).collect::<Vec<_>>()})).unwrap();
    let checked = runtime_observations(&document, &targets, &bindings, &plan).unwrap();
    assert!(
        check_runtime_plan(&plan, &checked.expected, &bindings)
            .unwrap()
            .is_empty()
    );
    let mut missing = bindings.clone();
    missing.remove(KUBERNETES_STORAGE);
    assert!(runtime_bindings(&targets, &missing).is_err());
    let mut drift = bindings.clone();
    drift.get_mut(KUBERNETES_STORAGE).unwrap().namespace = "elsewhere".into();
    assert!(runtime_bindings(&targets, &drift).is_err());
    for change in &mut plan.resource_changes {
        if change.address == "openshell_kubernetes_gateway.runtime" {
            change.change.actions = vec!["delete".into(), "create".into()];
        }
    }
    assert!(check_runtime_plan(&plan, &checked.expected, &bindings).is_err());
}

#[test]
fn opentofu_can_replace_an_unchanged_gateway_with_retained_storage() {
    let (document, _) = context();
    let (_, targets) = gateway_targets();
    let bindings: BTreeMap<String, StateBinding> = targets
        .iter()
        .map(|target| {
            (
                target.address.clone(),
                bound(format!("physical-{}", target.kind), target),
            )
        })
        .collect();
    // Core may choose replacement after taint or an explicit replacement request,
    // even when the desired process specification has not changed.
    let plan: Plan = serde_json::from_value(json!({"resource_changes": targets.iter().map(|target| json!({
        "address": target.address,
        "change": {
            "actions": if target.kind == GATEWAY_KIND { vec!["delete", "create"] } else { vec!["no-op"] },
            "before": before(&bindings[&target.address])
        }
    })).collect::<Vec<_>>()})).unwrap();
    let checked = runtime_observations(&document, &targets, &bindings, &plan).unwrap();
    assert_eq!(
        check_runtime_plan(&plan, &checked.expected, &bindings)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn bound_podman_gateway_requires_its_retained_storage_binding() {
    let (_, targets) = gateway_targets();
    let gateway = &targets[1];
    let bindings = BTreeMap::from([(gateway.address.clone(), bound("bound-gateway", gateway))]);
    assert!(runtime_bindings(&targets, &bindings).is_err());
}

#[test]
fn unbound_gateway_intent_is_checked_locally() {
    let (document, _) = context();
    let (_, targets) = gateway_targets();
    let plan: Plan = serde_json::from_value(
        json!({"resource_changes": targets.iter().map(|target| json!({
        "address": target.address, "change": {"actions": ["create"], "before": null}
    })).collect::<Vec<_>>()}),
    )
    .unwrap();
    let checked = runtime_observations(&document, &targets, &BTreeMap::new(), &plan).unwrap();
    assert_eq!(
        check_runtime_plan(&plan, &checked.expected, &BTreeMap::new(),)
            .unwrap()
            .len(),
        2
    );
    let mut bindings = BTreeMap::from([(
        GATEWAY_STORAGE.into(),
        StateBinding {
            image: "changed".into(),
            ..bound("storage", &targets[0])
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
            ..Default::default()
        },
    )]);
    let expected = runtime_bindings(std::slice::from_ref(&target), &bindings).unwrap();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address": target.address, "change":{"actions":["delete","create"],"before":{"id":"prior-container"}}}]})).unwrap();
    assert_eq!(
        check_runtime_plan(&plan, &expected, &bindings)
            .unwrap()
            .len(),
        1
    );
    let removed = runtime_bindings(&[], &bindings).unwrap();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address": target.address, "change":{"actions":["delete"],"before":{"id":"prior-container"}}}]})).unwrap();
    assert_eq!(
        check_runtime_plan(&plan, &removed, &bindings)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn removing_the_last_runtime_cannot_orphan_retained_state() {
    let desired =
        Document::parse(include_bytes!("../../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    assert!(!desired.has_runtime());
    let record = Record::new(desired.clone()).unwrap();
    let compiled = compile::deployment_graph(&desired, &record.generations, "0.1.0").unwrap();
    let bindings = BTreeMap::from([(
        "vllm_credential_storage.model".to_owned(),
        StateBinding {
            id: "daemon/volume/created".into(),
            spec: "retained".into(),
            ..Default::default()
        },
    )]);
    assert!(matches!(
        expected_bindings(&compiled, &bindings),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn docker_gateway_requires_durable_identity() {
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
            ..Default::default()
        },
    )]);
    assert!(runtime_bindings(&targets, &bindings).is_err());
    bindings.insert(storage.address.clone(), bound("durable", storage));
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address":gateway.address,"change":{"actions":["no-op"],"before":{"id":"container"}}}]})).unwrap();
    runtime_observations(&document, &targets, &bindings, &plan).unwrap();
}

#[test]
fn podman_gateway_replacement_depends_on_protected_storage_in_the_compiled_graph() {
    let document =
        Document::parse(include_bytes!("../../../../../examples/managed-podman.yaml").as_slice())
            .unwrap();
    let generations = Record::new(document.clone()).unwrap().generations;
    let graph = compile::compile_runtime(&document, &generations, "0.1.0").unwrap();
    let process = &graph["resource"]["openshell_podman_gateway"]["runtime"];
    assert_eq!(process["depends_on"], json!([GATEWAY_STORAGE]));
    assert_eq!(
        graph["resource"]["openshell_gateway_storage"]["runtime"]["lifecycle"]["prevent_destroy"],
        true
    );
}

fn kubernetes_bindings(targets: &[Target]) -> BTreeMap<String, StateBinding> {
    targets
        .iter()
        .map(|target| {
            let mut values = serde_json::to_value(&target.values).unwrap();
            values["id"] = json!(if target.address == crate::kubernetes::gateway::ADDRESS {
                target.values["name"].clone()
            } else {
                format!("physical-{}", target.kind)
            });
            (
                target.address.clone(),
                serde_json::from_value(values).unwrap(),
            )
        })
        .collect()
}

#[test]
fn kubernetes_helm_binding_requires_auth_and_the_same_release() {
    let (document, generations) = kubernetes_context();
    let targets = compile::runtime_targets(&document, &generations).unwrap();
    let bindings = kubernetes_bindings(&targets);
    runtime_bindings(&targets, &bindings).unwrap();
    for prerequisite in [
        KUBERNETES_STORAGE,
        "openshell_kubernetes_auth.runtime",
        crate::kubernetes::gateway::ADDRESS,
    ] {
        let mut missing = bindings.clone();
        missing.remove(prerequisite);
        assert!(runtime_bindings(&targets, &missing).is_err());
    }
    let mut changed = bindings.clone();
    changed
        .get_mut(crate::kubernetes::gateway::ADDRESS)
        .unwrap()
        .id = "foreign-release".into();
    assert!(runtime_bindings(&targets, &changed).is_err());
    // Interrupted initial installation can retain just storage and authentication.
    let mut partial = bindings;
    partial.remove("openshell_kubernetes_gateway.runtime");
    partial.remove(crate::kubernetes::gateway::ADDRESS);
    runtime_bindings(&targets, &partial).unwrap();
}

fn context() -> (Document, crate::compile::Generations) {
    let document =
        Document::parse(include_bytes!("../../../../../examples/spark/vllm.yaml").as_slice())
            .unwrap();
    let generations = Record::new(document.clone()).unwrap().generations;
    (document, generations)
}

fn gateway_targets() -> (Spec, Vec<Target>) {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../nemoclaw-provider/src/managed/reference.json"
    ))
    .unwrap();
    let mut spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    spec.compute_driver = crate::config::ComputeDriver::Podman;
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
            values: spec.gateway_row(kind).unwrap(),
        });
    }
    (spec, targets)
}

/// The binding OpenTofu state records for a compiled target.
fn bound(id: impl Into<String>, target: &Target) -> StateBinding {
    let value = |name: &str| target.values.get(name).cloned().unwrap_or_default();
    StateBinding {
        id: id.into(),
        spec: value("spec"),
        name: value("name"),
        owner: value("owner"),
        generation: value("generation"),
        engine: value("engine"),
        compute_driver: value("compute_driver"),
        endpoint: value("endpoint"),
        image: value("image"),
        network_cidr: value("network_cidr"),
        ..Default::default()
    }
}

/// Planned prior attributes of a bound resource.
fn before(binding: &StateBinding) -> Value {
    let mut before = json!(binding.typed_values());
    before["id"] = json!(binding.id);
    if !binding.spec.is_empty() {
        before["spec"] = json!(binding.spec);
    }
    before["running"] = json!("true");
    before
}

#[test]
fn runtime_checks_ignore_object_bindings_in_the_shared_state() {
    let (document, _) = kubernetes_context();
    let record = Record::new(document).unwrap();
    let targets = compile::runtime_targets(&record.document, &record.generations).unwrap();
    let mut bindings = kubernetes_bindings(&targets);
    bindings.insert(
        "openshell_workspace.deployment".into(),
        StateBinding {
            id: "workspace".into(),
            ..Default::default()
        },
    );
    assert!(
        runtime_bindings(&targets, &bindings).is_err(),
        "an object binding is not part of the runtime"
    );
    let runtime = runtime_saved(&record, &bindings).unwrap();
    assert!(!runtime.contains_key("openshell_workspace.deployment"));
    runtime_bindings(&targets, &runtime).unwrap();
}
