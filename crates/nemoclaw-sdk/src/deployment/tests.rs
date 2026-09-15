// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
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
#[ignore = "creates and removes only an explicitly configured experimental gateway; retains its storage"]
async fn managed_gateway_plan_apply_noop_destroy_and_recovery_use_real_opentofu() {
    let path =
        |name| PathBuf::from(std::env::var_os(name).expect("explicit managed qualification path"));
    let document =
        Document::parse(fs::File::open(path("NEMOCLAW_TEST_GATEWAY_DOCUMENT")).unwrap()).unwrap();
    assert_eq!(document.spec.gateway.management, "managed");
    assert!(document.spec.inference_providers[0].service.is_none());
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
    let engine = crate::docker::Engine::connect(&document.spec.gateway.engine).unwrap();
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
    drop(stage);
    assert_eq!(first.len(), 2);
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
    drop(store);
    let plan = deployment.plan_destroy(&cancel).await.unwrap();
    assert_eq!(plan.changes.len(), 1);
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
    assert_ne!(
        recovered["nemoclaw_managed_gateway.runtime"].id,
        first["nemoclaw_managed_gateway.runtime"].id
    );
    drop(stage);
    drop(store);
    deployment.destroy(&cancel).await.unwrap();
    assert!(engine.container(&name).await.unwrap().is_none());
}

#[test]
fn ollama_plan_accounts_for_storage_service_and_model_and_never_recreates_bound_model_data() {
    let document =
        Document::parse(include_str!("../../tests/fixtures/config/managed-ollama.yaml").as_bytes())
            .unwrap();
    let record = Record::new(document.clone()).unwrap();
    let mut expected = allowed(&compile::targets(&document, &record.generations).unwrap());
    ollama::extend_allowed(&document, &record.generations, &mut expected).unwrap();
    assert_eq!(expected.len(), 7);
    let bindings = [(
        "nemoclaw_ollama_model.inference".into(),
        StateBinding {
            id: "engine/container/created/model".into(),
            ..Default::default()
        },
    )]
    .into();
    let changes: Vec<_> = expected.iter().map(|(address,row)| json!({"address":address,"change":{"actions":["create"],"before":row}})).collect();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":changes})).unwrap();
    assert!(check_plan(&plan, &expected, &bindings).is_err());
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
