// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn gateway_observations_are_read_only_in_plans_and_discardable_during_teardown() {
    let address = "data.nemoclaw_gateway_capabilities.current";
    for action in ["read", "no-op"] {
        let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"mode":"data", "address":address, "change":{"actions":[action]}}]})).unwrap();
        assert!(
            check_plan(&plan, &BTreeMap::new(), &BTreeMap::new())
                .unwrap()
                .is_empty()
        );
        assert!(
            runtime::check_runtime_plan(
                &plan,
                &BTreeMap::new(),
                &BTreeMap::new(),
                &BTreeSet::new()
            )
            .unwrap()
            .is_empty()
        );
    }
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"mode":"data", "address":address, "change":{"actions":["delete"]}}]})).unwrap();
    assert!(
        check_destroy_plan(&plan, &BTreeMap::new(), &BTreeMap::new(), &BTreeSet::new())
            .unwrap()
            .is_empty()
    );
    for (mode, address, action) in [
        ("managed", address, "read"),
        ("data", "data.foreign.current", "read"),
        ("data", address, "create"),
        ("data", address, "delete"),
    ] {
        let value = json!({"mode":mode, "address":address, "change":{"actions":[action]}});
        let plan: Plan = serde_json::from_value(json!({"resource_changes":[value]})).unwrap();
        assert!(check_plan(&plan, &BTreeMap::new(), &BTreeMap::new()).is_err());
        assert!(
            runtime::check_runtime_plan(
                &plan,
                &BTreeMap::new(),
                &BTreeMap::new(),
                &BTreeSet::new()
            )
            .is_err()
        );
    }
    let change = json!({"mode":"data", "address":address, "change":{"actions":["read"]}});
    let duplicate: Plan =
        serde_json::from_value(json!({"resource_changes":[change, change]})).unwrap();
    assert!(check_plan(&duplicate, &BTreeMap::new(), &BTreeMap::new()).is_err());
}
#[test]
fn ordinary_plan_cannot_delete_replace_or_recreate_a_bound_resource() {
    let allowed = [("nemoclaw_workspace.deployment".into(), Row::new())].into();
    let bound = [(
        "nemoclaw_workspace.deployment".into(),
        StateBinding {
            id: "physical".into(),
            ..Default::default()
        },
    )]
    .into();
    for actions in [
        vec!["delete"],
        vec!["delete", "create"],
        vec!["create"],
        vec!["forget"],
    ] {
        let plan:Plan=serde_json::from_value(json!({"resource_changes":[{"address":"nemoclaw_workspace.deployment","change":{"actions":actions,"before":{"id":"physical"}}}]})).unwrap();
        assert!(check_plan(&plan, &allowed, &bound).is_err());
    }
}
#[test]
fn teardown_must_account_for_every_binding_and_retain_the_workspace() {
    let allowed = [("nemoclaw_workspace.deployment".into(), Row::new())].into();
    let bound = [(
        "nemoclaw_workspace.deployment".into(),
        StateBinding {
            id: "physical".into(),
            ..Default::default()
        },
    )]
    .into();
    let retained = ["nemoclaw_workspace.deployment".into()].into();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[]})).unwrap();
    assert!(check_destroy_plan(&plan, &allowed, &bound, &retained).is_err());
    let plan:Plan=serde_json::from_value(json!({"resource_changes":[{"address":"nemoclaw_workspace.deployment","change":{"actions":["delete"],"before":{"id":"physical"}}}]})).unwrap();
    assert!(check_destroy_plan(&plan, &allowed, &bound, &retained).is_err());
}

#[test]
fn credential_references_cannot_override_opentofu_control_variables() {
    struct Values;
    impl Secrets for Values {
        fn resolve(&self, _: &str) -> Result<String, crate::ObservationError> {
            Ok("foreign-config".into())
        }
    }
    let mut document =
        Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes()).unwrap();
    document.spec.inference_providers[0].endpoint = "https://example.com/v1".into();
    document.spec.inference_providers[0].credential = Some(Credential {
        env: "TF_CLI_CONFIG_FILE".into(),
    });
    assert!(command_environment(&document, &Values, Path::new("state")).is_err());
}

#[test]
fn runtime_replacement_requires_retained_storage_and_preserves_the_old_binding() {
    let address = "nemoclaw_inference_service.runtime";
    let expected = [(address.into(), Row::from([("spec".into(), "old".into())]))].into();
    let bindings = [(
        address.into(),
        StateBinding {
            id: "physical".into(),
            spec: "old".into(),
        },
    )]
    .into();
    let replacement = [address.into()].into();
    let plan:Plan = serde_json::from_value(json!({"resource_changes":[{"address":address,"change":{"actions":["delete","create"],"before":{"id":"physical","spec":"old"}}}]})).unwrap();
    assert!(runtime::check_runtime_plan(&plan, &expected, &bindings, &BTreeSet::new()).is_err());
    assert_eq!(
        runtime::check_runtime_plan(&plan, &expected, &bindings, &replacement)
            .unwrap()
            .len(),
        1
    );
    let mut wrong:Plan = serde_json::from_value(json!({"resource_changes":[{"address":address,"change":{"actions":["delete","create"],"before":{"id":"other","spec":"old"}}}]})).unwrap();
    assert!(runtime::check_runtime_plan(&wrong, &expected, &bindings, &replacement).is_err());
    wrong.resource_changes.clear();
    assert!(runtime::check_runtime_plan(&wrong, &expected, &bindings, &replacement).is_err());
    for action in [
        vec!["create"],
        vec!["delete"],
        vec!["forget"],
        vec!["create", "delete"],
    ] {
        let plan:Plan=serde_json::from_value(json!({"resource_changes":[{"address":address,"change":{"actions":action,"before":{"id":"physical","spec":"old"}}}]})).unwrap();
        assert!(runtime::check_runtime_plan(&plan, &expected, &bindings, &replacement).is_err());
    }
}

#[tokio::test]
#[ignore = "creates and removes only an explicitly configured test gateway; retains its storage"]
async fn managed_gateway_plan_apply_noop_destroy_and_recovery_use_real_opentofu() {
    let path =
        |name| PathBuf::from(std::env::var_os(name).expect("explicit managed qualification path"));
    let mut document =
        Document::parse(fs::File::open(path("NEMOCLAW_TEST_GATEWAY_DOCUMENT")).unwrap()).unwrap();
    assert!(document.spec.gateway.as_managed().is_some());
    assert!(document.spec.inference_providers[0].service_ref.is_none());
    assert!(document.spec.services.is_empty());
    let deployment = Deployment::new(
        &path("NEMOCLAW_TEST_GATEWAY_STATE"),
        &path("NEMOCLAW_TEST_BUNDLE"),
    );
    let cancel = CancellationToken::new();
    let (bundle, store) = deployment.open().unwrap();
    let mut record = store
        .load()
        .unwrap()
        .unwrap_or(Record::new(document.clone()).unwrap());
    assert_eq!(record.document.metadata.uid, document.metadata.uid);
    let engine =
        crate::docker::Engine::connect(&document.spec.gateway.as_managed().unwrap().engine)
            .unwrap();
    let name = format!("{}-gateway", document.workspace());
    let container_before = engine.container(&name).await.unwrap().map(|c| c.id);
    let volume_before = engine
        .volume(&format!("{name}-data"))
        .await
        .unwrap()
        .map(|v| v.created_at);
    deployment
        .runtime_stage(&bundle, &store, &document, &mut record, false, &cancel)
        .await
        .unwrap();
    assert_eq!(
        engine.container(&name).await.unwrap().map(|c| c.id),
        container_before,
        "plan created a runtime"
    );
    assert_eq!(
        engine
            .volume(&format!("{name}-data"))
            .await
            .unwrap()
            .map(|v| v.created_at),
        volume_before,
        "plan created storage"
    );
    deployment
        .runtime_stage(&bundle, &store, &document, &mut record, true, &cancel)
        .await
        .unwrap();
    let stage = Store::open(&store.directory.join("runtime")).unwrap();
    let first = stage.bindings().unwrap();
    let state: Value =
        serde_json::from_slice(&fs::read(stage.directory.join("terraform.tfstate")).unwrap())
            .unwrap();
    let readiness = state["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|resource| {
            resource["mode"] == "data" && resource["type"] == "nemoclaw_gateway_capabilities"
        })
        .expect("runtime apply must record provider-owned readiness");
    assert_eq!(readiness["instances"][0]["attributes"]["compatible"], true);
    drop(stage);
    let docker = document.spec.sandboxes[0].runtime.provider == "docker";
    let compute = if docker {
        "docker_container.managed_gateway_runtime"
    } else {
        "nemoclaw_managed_gateway.runtime"
    };
    assert_eq!(first.len(), if docker { 3 } else { 2 });
    let (changes, deferred) = deployment
        .runtime_stage(&bundle, &store, &document, &mut record, true, &cancel)
        .await
        .unwrap();
    assert!(changes.is_empty() && !deferred);
    let stage = Store::open(&store.directory.join("runtime")).unwrap();
    for (address, binding) in stage.bindings().unwrap() {
        assert_eq!(binding.id, first[&address].id);
    }
    drop(stage);
    if docker {
        for remove in [false, true] {
            let old = engine.container(&name).await.unwrap().unwrap().id.unwrap();
            engine.api.stop_container(&old, None).await.unwrap();
            if remove {
                engine.api.remove_container(&old, None).await.unwrap();
            }
            deployment
                .runtime_stage(&bundle, &store, &document, &mut record, true, &cancel)
                .await
                .unwrap();
            let current = engine.container(&name).await.unwrap().unwrap();
            assert_eq!(current.state.unwrap().running, Some(true));
            if remove {
                assert_ne!(current.id.as_deref(), Some(old.as_str()));
            }
            assert_eq!(
                Store::open(&store.directory.join("runtime"))
                    .unwrap()
                    .bindings()
                    .unwrap()["nemoclaw_gateway_storage.runtime"]
                    .id,
                first["nemoclaw_gateway_storage.runtime"].id
            );
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let old = engine.container(&name).await.unwrap().unwrap().id;
        *document.spec.gateway.endpoint_mut() = format!("http://127.0.0.1:{port}");
        deployment
            .runtime_stage(&bundle, &store, &document, &mut record, true, &cancel)
            .await
            .unwrap();
        assert_ne!(engine.container(&name).await.unwrap().unwrap().id, old);
        let stage = Store::open(&store.directory.join("runtime")).unwrap();
        assert_eq!(
            stage.bindings().unwrap()["nemoclaw_gateway_storage.runtime"].id,
            first["nemoclaw_gateway_storage.runtime"].id
        );
        let state_path = stage.directory.join("terraform.tfstate");
        let prior = fs::read(&state_path).unwrap();
        drop(stage);
        let data_path = engine
            .volume(&format!("{name}-data"))
            .await
            .unwrap()
            .unwrap()
            .mountpoint;
        let helper = engine
            .container(&format!("{name}-initialize"))
            .await
            .unwrap()
            .unwrap()
            .id
            .unwrap();
        let key_path =
            format!("{data_path}/state/openshell/gateway/credentials/key-encryption-key.bin");
        let key = engine
            .read_file(&helper, &key_path, 32)
            .await
            .unwrap()
            .unwrap();
        let mut replacement = key.clone();
        replacement[0] ^= 1;
        engine
            .write_credential_key(&helper, &data_path, &replacement)
            .await
            .unwrap();
        assert!(
            deployment
                .runtime_stage(&bundle, &store, &document, &mut record, true, &cancel)
                .await
                .is_err()
        );
        assert_eq!(fs::read(state_path).unwrap(), prior);
        engine
            .write_credential_key(&helper, &data_path, &key)
            .await
            .unwrap();
        deployment
            .runtime_stage(&bundle, &store, &document, &mut record, true, &cancel)
            .await
            .unwrap();
    }
    drop(store);
    let plan = deployment.plan_destroy(&cancel).await.unwrap();
    assert_eq!(plan.changes.len(), if docker { 2 } else { 1 });
    assert_eq!(plan.retained, vec!["nemoclaw_gateway_storage.runtime"]);
    deployment.destroy(&cancel).await.unwrap();
    assert!(engine.container(&name).await.unwrap().is_none());
    let (bundle, store) = deployment.open().unwrap();
    let mut record = store.load().unwrap().unwrap();
    deployment
        .runtime_stage(&bundle, &store, &document, &mut record, true, &cancel)
        .await
        .unwrap();
    let stage = Store::open(&store.directory.join("runtime")).unwrap();
    let recovered = stage.bindings().unwrap();
    assert_eq!(
        recovered["nemoclaw_gateway_storage.runtime"].id,
        first["nemoclaw_gateway_storage.runtime"].id
    );
    assert_ne!(recovered[compute].id, first[compute].id);
    drop(stage);
    drop(store);
    deployment.destroy(&cancel).await.unwrap();
    assert!(engine.container(&name).await.unwrap().is_none());
}

#[test]
fn ollama_runtime_plan_allows_native_compute_and_cache_recovery() {
    let document =
        Document::parse(include_str!("../../tests/fixtures/config/managed-ollama.yaml").as_bytes())
            .unwrap();
    let record = Record::new(document.clone()).unwrap();
    let expected = allowed(&compile::runtime_targets(&document, &record.generations).unwrap());
    assert_eq!(expected.len(), 6);
    let mut bindings = BTreeMap::from([(
        "docker_container.ollama_service_ollama-server".into(),
        StateBinding {
            id: "container".into(),
            ..Default::default()
        },
    )]);
    let changes: Vec<_> = expected.iter().map(|(address,row)| json!({"address":address,"change":{"actions":["create"],"before":row}})).collect();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":changes})).unwrap();
    assert!(check_plan(&plan, &expected, &bindings).is_ok());
    bindings.insert(
        "docker_volume.ollama_service_storage_ollama-server".into(),
        StateBinding {
            id: "engine/volume/created".into(),
            spec: String::new(),
        },
    );
    assert!(check_plan(&plan, &expected, &bindings).is_ok());
    assert!(check_plan(&plan, &expected, &BTreeMap::new()).is_ok());
}

#[test]
fn public_operation_futures_fit_the_async_callers_stack_budget() {
    let document =
        Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes()).unwrap();
    let deployment = Deployment::new(Path::new("unused-state"), Path::new("unused-bundle"));
    let cancel = CancellationToken::new();
    // Callers may compose several operations on a normal 2 MiB executor stack.
    // Keep each public future below 16 KiB; backend work can live on the heap.
    for (operation, size) in [
        (
            "plan",
            std::mem::size_of_val(&deployment.plan(&document, &cancel)),
        ),
        (
            "apply",
            std::mem::size_of_val(&deployment.apply(&document, &cancel)),
        ),
        ("export", std::mem::size_of_val(&deployment.export(&cancel))),
        (
            "plan_destroy",
            std::mem::size_of_val(&deployment.plan_destroy(&cancel)),
        ),
        (
            "destroy",
            std::mem::size_of_val(&deployment.destroy(&cancel)),
        ),
    ] {
        assert!(
            size <= 16 * 1024,
            "{operation} embeds {size} bytes in its caller"
        );
    }
}

#[test]
fn destroy_drift_errors_distinguish_undeclared_resources_from_missing_saved_ids() {
    let address = "nemoclaw_sandbox.assistant";
    let plan: Plan = serde_json::from_value(json!({
        "resource_drift":[{
            "address": address, "change": {"actions":["update"], "before":{"id":"saved-id"}}
        }],
        "resource_changes":[{
            "address": address, "change": {"actions":["delete"], "before":{"id":"saved-id"}}
        }]
    }))
    .unwrap();
    let allowed = [(address.into(), Row::new())].into();
    let bindings = [(
        address.into(),
        StateBinding {
            id: "saved-id".into(),
            ..Default::default()
        },
    )]
    .into();
    let retained = BTreeSet::new();
    assert_eq!(
        check_destroy_plan(&plan, &BTreeMap::new(), &bindings, &retained)
            .unwrap_err()
            .to_string(),
        "destroy plan reports changes to an undeclared resource"
    );
    assert_eq!(
        check_destroy_plan(&plan, &allowed, &BTreeMap::new(), &retained)
            .unwrap_err()
            .to_string(),
        "destroy plan reports changes to a resource without a saved ID"
    );
    assert!(check_destroy_plan(&plan, &allowed, &bindings, &retained).is_ok());
}

#[test]
fn runtime_plans_accept_only_declared_local_image_observations_and_teardown_deletions() {
    let document =
        Document::parse(include_bytes!("../../../../examples/spark/two-models.yaml").as_slice())
            .unwrap();
    let record = Record::new(document.clone()).unwrap();
    let targets = compile::runtime_targets(&document, &record.generations).unwrap();
    let mut allowed = allowed(&targets);
    let address = "data.docker_image.image_local".to_string();
    allowed.insert(address.clone(), Row::new());
    let resources: Vec<_> = targets.iter().map(|target| json!({"mode":"managed", "address":target.address, "change":{"actions":["create"]}})).collect();
    for (action, duplicate, valid) in [
        ("read", false, true),
        ("no-op", false, true),
        ("read", true, false),
        ("delete", false, false),
        ("create", false, false),
    ] {
        let observation = json!({"mode":"data", "address":address, "change":{"actions":[action]}});
        let mut changes = resources.clone();
        changes.push(observation.clone());
        if duplicate {
            changes.push(observation);
        }
        let plan: Plan = serde_json::from_value(json!({"resource_changes":changes})).unwrap();
        assert_eq!(
            runtime::check_runtime_plan(&plan, &allowed, &BTreeMap::new(), &BTreeSet::new())
                .is_ok(),
            valid
        );
    }
    let foreign = crate::services::capacity::observation_address(
        &document.spec.gateway.as_managed().unwrap().engine,
    );
    for (address, valid) in [(address.as_str(), true), (foreign.as_str(), false)] {
        let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"mode":"data", "address":address, "change":{"actions":["delete"]}}]})).unwrap();
        assert_eq!(
            check_destroy_plan(&plan, &allowed, &BTreeMap::new(), &BTreeSet::new()).is_ok(),
            valid
        );
    }
}

#[test]
fn disposable_docker_compute_reconciles_while_durable_storage_does_not_recreate() {
    let compute = "docker_container.inference_service_model";
    let allowed = [(compute.into(), Row::new())].into();
    let bound = [(
        compute.into(),
        StateBinding {
            id: "old-container".into(),
            spec: String::new(),
        },
    )]
    .into();
    for actions in [
        json!(["create"]),
        json!(["delete", "create"]),
        json!(["create", "delete"]),
        json!(["delete"]),
    ] {
        let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address":compute,"change":{"actions":actions,"before":{"id":"old-container"}}}]})).unwrap();
        assert_eq!(check_plan(&plan, &allowed, &bound).unwrap().len(), 1);
    }
    let storage = "nemoclaw_inference_storage.model";
    let allowed = [(storage.into(), Row::new())].into();
    let bound = [(
        storage.into(),
        StateBinding {
            id: "daemon/data/created".into(),
            spec: String::new(),
        },
    )]
    .into();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address":storage,"change":{"actions":["create"],"before":null}}]})).unwrap();
    assert!(check_plan(&plan, &allowed, &bound).is_err());
}
