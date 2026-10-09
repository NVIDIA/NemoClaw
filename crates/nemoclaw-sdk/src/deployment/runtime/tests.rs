// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{deployment::tests::kubernetes_context, managed::GATEWAY_STORAGE_KIND};

const GATEWAY: &str = "nemoclaw_managed_gateway.runtime";

#[test]
fn bound_cluster_port_change_explains_required_teardown_before_runtime_reconciliation() {
    for source in [
        include_str!("../../../../../examples/kubernetes/local-vllm.yaml"),
        include_str!("../../../../../examples/kubernetes/local-ollama.yaml"),
    ] {
        let document = Document::parse(source.as_bytes()).unwrap();
        let record = Record::new(document.clone()).unwrap();
        // The early guard receives only the main state's OpenShell resources;
        // managed model services belong to the separate runtime state.
        let targets = compile::targets(&document, &record.generations).unwrap();
        let bindings = kubernetes_bindings(&targets);
        assert!(
            bindings
                .keys()
                .any(|address| address.starts_with("openshell_sandbox."))
        );
        assert!(!bindings.contains_key("nemoclaw_kubernetes_service.qwen"));
        let mut changed = serde_json::to_value(&document).unwrap();
        changed["spec"]["services"]["qwen"]["serving"]["port"] = json!(19001);
        let changed = Document::parse(changed.to_string().as_bytes()).unwrap();
        let error = validate_bound_sandboxes(&record, &changed, &bindings).unwrap_err();
        let message = error.to_string();
        for required in [
            "model serving port",
            "whole-deployment destroy and apply",
            "sandbox files and conversation history",
            "retains model and credential PVCs",
        ] {
            assert!(
                message.contains(required),
                "missing {required:?}: {message}"
            );
        }
        validate_bound_sandboxes(&record, &changed, &BTreeMap::new()).unwrap();
    }
}

#[tokio::test]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; separate local OpenTofu states"]
async fn plan_and_apply_refuse_cluster_port_changes_with_separate_state_files() {
    fn state_block(fields: &nemoclaw_tofu::shape::Fields, value: &Value) -> Value {
        use nemoclaw_tofu::shape::Shape;

        fields
            .iter()
            .map(|(name, field)| {
                let value = &value[name];
                let value = match &field.shape {
                    Shape::Object(fields) if field.required => state_block(fields, value),
                    Shape::Object(fields) => {
                        if value.is_null() {
                            json!([])
                        } else {
                            json!([state_block(fields, value)])
                        }
                    }
                    Shape::ObjectList(fields) => value
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|item| state_block(fields, item))
                        .collect(),
                    Shape::ObjectMap(fields) => value
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(key, item)| (key.clone(), state_block(fields, item)))
                        .collect(),
                    _ => value.clone(),
                };
                (name.clone(), value)
            })
            .collect()
    }

    let bundle_path = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    for source in [
        include_str!("../../../../../examples/kubernetes/local-vllm.yaml"),
        include_str!("../../../../../examples/kubernetes/local-ollama.yaml"),
    ] {
        let document = Document::parse(source.as_bytes()).unwrap();
        let record = Record::new(document.clone()).unwrap();
        let directory = tempfile::tempdir().unwrap();
        {
            let store = Store::open(directory.path()).unwrap();
            store.save(&record).unwrap();
        }
        let main = compile::targets(&document, &record.generations).unwrap();
        let runtime = compile::runtime_targets(&document, &record.generations).unwrap();
        let sandbox = main.iter().find(|target| target.kind == "sandbox").unwrap();
        let model = runtime
            .iter()
            .find(|target| target.kind == crate::kubernetes::services::SERVICE_KIND)
            .unwrap();
        // Materialize native state files rather than combining the two stages'
        // bindings. Real OpenTofu decodes these through the packaged schemas.
        let native_state = |target: &Target| {
            let (kind, name) = target.address.split_once('.').unwrap();
            let provider = if kind.starts_with("openshell_") {
                compile::OPENSHELL_PROVIDER_ADDRESS
            } else {
                compile::PROVIDER_ADDRESS
            };
            let mut attributes = serde_json::to_value(&target.values).unwrap();
            for input in nemoclaw_openshell::structured_inputs(&target.kind) {
                let encoded = attributes
                    .as_object_mut()
                    .unwrap()
                    .remove(input.field)
                    .unwrap();
                let value = input.configuration(encoded.as_str().unwrap()).unwrap();
                attributes[input.attribute] = match &input.shape {
                    nemoclaw_tofu::shape::Shape::Object(fields) => {
                        json!([state_block(fields, &value)])
                    }
                    _ => value,
                };
            }
            attributes["id"] = json!(format!("physical-{}", target.kind));
            json!({
                "version": 4, "terraform_version": compile::OPENTOFU_VERSION,
                "serial": 1, "lineage": "cd73e09f-c75c-48ce-86af-352a4764560e", "outputs": {},
                "resources": [{
                    "mode": "managed", "type": kind, "name": name,
                    "provider": format!("provider[\"{provider}\"]"),
                    "instances": [{"schema_version": 0, "attributes": attributes}]
                }]
            })
        };
        fs::create_dir(directory.path().join("runtime")).unwrap();
        save_json(
            &directory.path().join("terraform.tfstate"),
            &native_state(sandbox),
        )
        .unwrap();
        save_json(
            &directory.path().join("runtime/terraform.tfstate"),
            &native_state(model),
        )
        .unwrap();
        let saved: Vec<_> = [
            "intent.json",
            "terraform.tfstate",
            "runtime/terraform.tfstate",
        ]
        .into_iter()
        .map(|name| (name, fs::read(directory.path().join(name)).unwrap()))
        .collect();
        let mut changed = serde_json::to_value(&document).unwrap();
        changed["spec"]["services"]["qwen"]["serving"]["port"] = json!(19001);
        let changed = Document::parse(changed.to_string().as_bytes()).unwrap();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = events.clone();
        let deployment = Deployment::new(directory.path(), &bundle_path)
            .with_progress(Arc::new(move |event| captured.lock().unwrap().push(event)));
        for apply in [false, true] {
            let cancel = CancellationToken::new();
            let error = if apply {
                deployment.apply(&changed, &cancel).await
            } else {
                deployment.plan(&changed, &cancel).await
            }
            .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("changing the model serving port"),
                "{error}"
            );
            assert!(!events.lock().unwrap().contains(&Progress::MutationStarted));
            for (name, bytes) in &saved {
                assert_eq!(
                    &fs::read(directory.path().join(name)).unwrap(),
                    bytes,
                    "{name}"
                );
            }
            assert!(
                !directory.path().join("runtime/main.tf.json").exists(),
                "runtime reconciliation must not start"
            );
        }
    }
}

#[test]
fn unrelated_sandbox_or_storage_changes_keep_their_original_refusal() {
    for source in [
        include_str!("../../../../../examples/kubernetes/local-vllm.yaml"),
        include_str!("../../../../../examples/kubernetes/local-ollama.yaml"),
    ] {
        let document = Document::parse(source.as_bytes()).unwrap();
        let record = Record::new(document.clone()).unwrap();
        let targets = compile::targets(&document, &record.generations).unwrap();
        let bindings = kubernetes_bindings(&targets);
        for change in ["sandbox image", "storage and port"] {
            let mut revised = serde_json::to_value(&document).unwrap();
            if change == "sandbox image" {
                revised["spec"]["sandboxes"][0]["image"]["ref"] = json!(format!(
                    "registry.example.com/changed@sha256:{}",
                    "b".repeat(64)
                ));
            } else {
                revised["spec"]["services"]["qwen"]["serving"]["port"] = json!(19001);
                revised["spec"]["services"]["qwen"]["kubernetes"]["storageGiB"] = json!(200);
            }
            let revised = Document::parse(revised.to_string().as_bytes()).unwrap();
            assert!(
                matches!(
                    validate_bound_sandboxes(&record, &revised, &bindings),
                    Err(Error::SandboxChangeRefused { .. })
                ),
                "{change}"
            );
        }
    }
}

#[test]
fn cluster_service_changes_keep_bound_storage_and_require_all_recorded_prerequisites() {
    for source in [
        include_str!("../../../../../examples/kubernetes/local-vllm.yaml"),
        include_str!("../../../../../examples/kubernetes/local-ollama.yaml"),
    ] {
        let document = Document::parse(source.as_bytes()).unwrap();
        let record = Record::new(document.clone()).unwrap();
        let targets = compile::runtime_targets(&document, &record.generations).unwrap();
        let bindings = kubernetes_bindings(&targets);
        runtime_bindings(&targets, &bindings).unwrap();
        for prerequisite in [
            KUBERNETES_STORAGE,
            "nemoclaw_kubernetes_gateway.runtime",
            "nemoclaw_kubernetes_service_storage.qwen",
        ] {
            let mut missing = bindings.clone();
            missing.remove(prerequisite);
            assert!(runtime_bindings(&targets, &missing).is_err());
        }
        let mut input = serde_json::to_value(&document).unwrap();
        input["spec"]["services"]["qwen"]["kubernetes"]["cpuLimitMillis"] = json!(8000);
        let changed = Document::parse(input.to_string().as_bytes()).unwrap();
        let updated = compile::runtime_targets(&changed, &record.generations).unwrap();
        let expected = runtime_bindings(&updated, &bindings).unwrap();
        assert_eq!(
            expected["nemoclaw_kubernetes_service.qwen"]["spec"],
            bindings["nemoclaw_kubernetes_service.qwen"].spec
        );
        input["spec"]["services"]["qwen"]["kubernetes"]["storageGiB"] = json!(200);
        let resized = Document::parse(input.to_string().as_bytes()).unwrap();
        let updated = compile::runtime_targets(&resized, &record.generations).unwrap();
        assert!(runtime_bindings(&updated, &bindings).is_err());
    }
}

#[test]
fn kubernetes_gateway_requires_storage_and_fresh_readiness_without_replacement() {
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
    assert!(checked.gateway_running);
    assert!(
        check_runtime_plan(&plan, &checked.expected, &bindings)
            .unwrap()
            .is_empty()
    );
    let gateway = plan
        .resource_changes
        .iter_mut()
        .find(|change| change.address == "nemoclaw_kubernetes_gateway.runtime")
        .unwrap();
    gateway.change.before["running"] = json!("false");
    assert!(
        !runtime_observations(&document, &targets, &bindings, &plan)
            .unwrap()
            .gateway_running
    );
    let mut missing = bindings.clone();
    missing.remove(KUBERNETES_STORAGE);
    assert!(runtime_bindings(&targets, &missing).is_err());
    let mut drift = bindings.clone();
    drift.get_mut(KUBERNETES_STORAGE).unwrap().namespace = "elsewhere".into();
    assert!(runtime_bindings(&targets, &drift).is_err());
    for change in &mut plan.resource_changes {
        if change.address == "nemoclaw_kubernetes_gateway.runtime" {
            change.change.actions = vec!["delete".into(), "create".into()];
        }
    }
    assert!(check_runtime_plan(&plan, &checked.expected, &bindings).is_err());
}

#[test]
fn failed_kubernetes_model_rollout_accepts_only_revised_model_workloads() {
    let working = Document::parse(
        include_bytes!("../../../../../examples/kubernetes/local-ollama.yaml").as_slice(),
    )
    .unwrap();
    let mut failed = serde_json::to_value(&working).unwrap();
    failed["spec"]["services"]["qwen"]["model"]["digest"] = json!("a".repeat(64));
    let failed = Document::parse(failed.to_string().as_bytes()).unwrap();
    let mut record = Record::new(failed.clone()).unwrap();
    record.begin_runtime_apply(&failed);
    assert!(
        record.validate_pending_intent(&working).is_ok(),
        "a failed model rollout must permit restoring the working model"
    );
    for (path, value) in [
        ("/spec/sandboxes/0/name", json!("renamed")),
        (
            "/spec/gateway/kubernetes/namespace",
            json!("another-target"),
        ),
        ("/spec/services/qwen/kubernetes/storageGiB", json!(200)),
    ] {
        let mut revised = serde_json::to_value(&working).unwrap();
        *revised.pointer_mut(path).unwrap() = value;
        let revised = Document::parse(revised.to_string().as_bytes()).unwrap();
        assert!(
            record.validate_pending_intent(&revised).is_err(),
            "unrelated change at {path}"
        );
    }
}

#[tokio::test]
async fn plan_and_apply_warn_about_unauthenticated_cluster_network_boundaries_before_mutation() {
    for (source, remove_authentication, needs_warning) in [
        (
            include_bytes!("../../../../../examples/kubernetes/local-ollama.yaml").as_slice(),
            false,
            true,
        ),
        (
            include_bytes!("../../../../../examples/kubernetes/local-vllm.yaml").as_slice(),
            false,
            false,
        ),
        (
            include_bytes!("../../../../../examples/kubernetes/local-vllm.yaml").as_slice(),
            true,
            true,
        ),
        (
            include_bytes!("../../../../../examples/managed-ollama-gpu.yaml").as_slice(),
            false,
            false,
        ),
    ] {
        let mut document = Document::parse(source).unwrap();
        if remove_authentication {
            let crate::services::ServiceDefinition::Vllm(service) =
                document.spec.services.get_mut("qwen").unwrap()
            else {
                unreachable!()
            };
            service.authentication = None;
        }
        for apply in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let events = Arc::new(std::sync::Mutex::new(Vec::new()));
            let saved = events.clone();
            let deployment = Deployment::new(
                &directory.path().join("state"),
                &directory.path().join("missing-bundle"),
            )
            .with_progress(Arc::new(move |event| saved.lock().unwrap().push(event)));
            let result = if apply {
                deployment.apply(&document, &CancellationToken::new()).await
            } else {
                deployment.plan(&document, &CancellationToken::new()).await
            };
            assert!(result.is_err());
            let events = events.lock().unwrap();
            let warnings: Vec<_> = events
                .iter()
                .filter_map(|event| match event {
                    Progress::Warning { message } if message.contains("NetworkPolicy") => {
                        Some(message)
                    }
                    _ => None,
                })
                .collect();
            assert_eq!(warnings.len(), usize::from(needs_warning));
            if needs_warning {
                assert!(warnings[0].contains("qwen") && warnings[0].contains("NetworkPolicy"));
            }
            assert!(!events.contains(&Progress::MutationStarted));
        }
    }
}

#[test]
fn interrupted_kubernetes_platform_apply_cannot_move_to_another_namespace() {
    let (document, _) = kubernetes_context();
    let mut record = Record::new(document.clone()).unwrap();
    record.begin_runtime_apply(&document);
    assert!(record.validate_pending_intent(&document).is_ok());
    let mut changed = document.clone();
    changed
        .spec
        .gateway
        .as_managed_mut()
        .unwrap()
        .kubernetes
        .as_mut()
        .unwrap()
        .namespace = "another-target".into();
    assert!(record.validate_pending_intent(&changed).is_err());
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
fn gateway_deferral_uses_refreshed_plan_observations() {
    let (document, _) = context();
    let (_, mut targets) = gateway_targets();
    let bindings: BTreeMap<String, StateBinding> = targets
        .iter()
        .map(|target| {
            (
                target.address.clone(),
                bound(format!("physical-{}", target.kind), target),
            )
        })
        .collect();
    let mut want = Spec::from_values(GATEWAY_KIND, &targets[1].values).unwrap();
    want.gateway.endpoint = "http://127.0.0.1:17682".into();
    want.write_values(GATEWAY_KIND, &mut targets[1].values)
        .unwrap();
    let changes: Vec<Value> = targets.iter().map(|target| json!({
        "address": target.address,
        "change": {
            "actions": if target.kind == GATEWAY_KIND { vec!["delete", "create"] } else { vec!["no-op"] },
            "before": before(&bindings[&target.address])
        }
    })).collect();
    let mut plan: Plan = serde_json::from_value(json!({"resource_changes": changes})).unwrap();
    let checked = runtime_observations(&document, &targets, &bindings, &plan).unwrap();
    assert!(checked.gateway_running);
    assert_eq!(
        check_runtime_plan(&plan, &checked.expected, &bindings)
            .unwrap()
            .len(),
        1
    );
    plan.resource_changes[1].change.before["running"] = json!("false");
    assert!(
        !runtime_observations(&document, &targets, &bindings, &plan)
            .unwrap()
            .gateway_running
    );
    for invalid in [
        json!({"actions": ["create"], "before": null}),
        json!({"actions": ["no-op"], "before": {"id": "other", "spec": bindings[GATEWAY_STORAGE].spec}}),
        json!({"actions": ["no-op"], "before": {"id": bindings[GATEWAY_STORAGE].id, "spec": "changed"}}),
    ] {
        plan.resource_changes[0].change = serde_json::from_value(invalid).unwrap();
        let checked = runtime_observations(&document, &targets, &bindings, &plan).unwrap();
        assert!(check_runtime_plan(&plan, &checked.expected, &bindings).is_err());
    }
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
fn unbound_gateway_is_deferred_and_retained_intent_is_checked_locally() {
    let (document, _) = context();
    let (_, targets) = gateway_targets();
    let plan: Plan = serde_json::from_value(
        json!({"resource_changes": targets.iter().map(|target| json!({
        "address": target.address, "change": {"actions": ["create"], "before": null}
    })).collect::<Vec<_>>()}),
    )
    .unwrap();
    let checked = runtime_observations(&document, &targets, &BTreeMap::new(), &plan).unwrap();
    assert!(!checked.gateway_running);
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
            ..Default::default()
        },
    )]);
    assert!(runtime_bindings(&targets, &bindings).is_err());
    bindings.insert(storage.address.clone(), bound("durable", storage));
    for (actions, running) in [
        (vec!["no-op"], true),
        (vec!["delete", "create"], false),
        (vec!["create"], false),
    ] {
        let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address":gateway.address,"change":{"actions":actions,"before":{"id":"container"}}}]})).unwrap();
        let observed = runtime_observations(&document, &targets, &bindings, &plan).unwrap();
        assert_eq!(observed.gateway_running, running);
    }
}

#[test]
fn podman_gateway_replacement_depends_on_protected_storage_in_the_compiled_graph() {
    let document =
        Document::parse(include_bytes!("../../../../../examples/managed-podman.yaml").as_slice())
            .unwrap();
    let generations = Record::new(document.clone()).unwrap().generations;
    let graph = compile::compile_runtime(&document, &generations, "0.1.0").unwrap();
    let process = &graph["resource"]["nemoclaw_managed_gateway"]["runtime"];
    assert_eq!(process["depends_on"], json!([GATEWAY_STORAGE]));
    assert_eq!(
        graph["resource"]["nemoclaw_gateway_storage"]["runtime"]["lifecycle"]["prevent_destroy"],
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
        "nemoclaw_kubernetes_auth.runtime",
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
    partial.remove("nemoclaw_kubernetes_gateway.runtime");
    partial.remove(crate::kubernetes::gateway::ADDRESS);
    runtime_bindings(&targets, &partial).unwrap();
}
