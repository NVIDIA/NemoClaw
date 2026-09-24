// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::config::{ComputeDriver, Gateway};

use super::*;

#[test]
fn gateway_observations_are_read_only_in_plans_and_discardable_during_teardown() {
    for address in [
        compile::GATEWAY_CAPABILITIES_ADDRESS,
        compile::GATEWAY_APPLY_CAPABILITIES_ADDRESS,
    ] {
        for action in ["read", "no-op"] {
            let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"mode":"data", "address":address, "change":{"actions":[action]}}]})).unwrap();
            assert!(
                check_plan(&plan, &BTreeMap::new(), &BTreeMap::new())
                    .unwrap()
                    .is_empty()
            );
            assert!(
                runtime::check_runtime_plan(&plan, &BTreeMap::new(), &BTreeMap::new())
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
                runtime::check_runtime_plan(&plan, &BTreeMap::new(), &BTreeMap::new()).is_err()
            );
        }
        let change = json!({"mode":"data", "address":address, "change":{"actions":["read"]}});
        let duplicate: Plan =
            serde_json::from_value(json!({"resource_changes":[change, change]})).unwrap();
        assert!(check_plan(&duplicate, &BTreeMap::new(), &BTreeMap::new()).is_err());
    }
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
fn reconstructible_recreation_uses_opentofu_state_after_refresh_only() {
    // After OpenTofu commits refresh, its next plan need not report absence again.
    // Supplied bindings must not override OpenTofu's reconstructible transitions.
    let address = "nemoclaw_provider.example";
    let allowed = [(address.into(), Row::new())].into();
    let bindings = [(
        address.into(),
        StateBinding {
            id: "previous-registration".into(),
            ..Default::default()
        },
    )]
    .into();
    let plan: Plan = serde_json::from_value(json!({"resource_changes": [{
        "address": address,
        "change": {"actions": ["create"], "before": null, "after": {"name": "example"}}
    }]}))
    .unwrap();
    let changes = check_plan(&plan, &allowed, &bindings).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].actions, ["create"]);
}

#[test]
fn reconstructible_resources_support_removal_replacement_and_confirmed_absence() {
    for kind in ["provider", "provider_profile", "pi_configuration"] {
        let address = format!("nemoclaw_{kind}.example");
        let expected = [(address.clone(), Row::new())].into();
        let bindings = [(
            address.clone(),
            StateBinding {
                id: "physical".into(),
                ..Default::default()
            },
        )]
        .into();
        for actions in [
            json!(["update"]),
            json!(["delete", "create"]),
            json!(["create", "delete"]),
        ] {
            let plan: Plan = serde_json::from_value(json!({"resource_changes":[{
                "address":address,"change":{"actions":actions,"before":{"id":"physical"}}
            }]}))
            .unwrap();
            assert!(
                check_plan(&plan, &expected, &bindings).is_ok(),
                "{kind}: {actions}"
            );
        }
        let removal: Plan = serde_json::from_value(json!({"resource_changes":[{
            "address":address,"change":{"actions":["delete"],"before":{"id":"physical"}}
        }]}))
        .unwrap();
        assert!(check_plan(&removal, &BTreeMap::new(), &bindings).is_ok());
        let recreation: Plan = serde_json::from_value(json!({
            "resource_changes":[{"address":address,"change":{"actions":["create"],"after":{"name":"desired"}}}],
            "resource_drift":[{"address":address,"change":{"actions":["delete"],"before":{"id":"physical"}}}]
        })).unwrap();
        assert!(check_plan(&recreation, &expected, &bindings).is_ok());
        let removed_and_absent: Plan = serde_json::from_value(json!({
            "resource_changes":[{"address":address,"change":{"actions":["no-op"],"before":null,"after":null}}],
            "resource_drift":[{"address":address,"change":{"actions":["delete"],"before":{"id":"physical"}}}]
        })).unwrap();
        assert!(check_plan(&removed_and_absent, &BTreeMap::new(), &bindings).is_ok());
    }
}

#[test]
fn reconstructible_resource_plans_keep_scope_without_rechecking_provider_identity() {
    let address = "nemoclaw_provider.example";
    let expected = [(address.into(), Row::new())].into();
    let bindings = [(
        address.into(),
        StateBinding {
            id: "previous".into(),
            ..Default::default()
        },
    )]
    .into();
    let plan: Plan = serde_json::from_value(json!({"resource_changes": [{
        "address": address, "change": {"actions": ["no-op"], "before": {"id": "refreshed"}, "after": {"id": "refreshed"}}
    }]})).unwrap();
    assert!(check_plan(&plan, &expected, &bindings).unwrap().is_empty());
    assert!(check_plan(&plan, &BTreeMap::new(), &BTreeMap::new()).is_err());
    let omitted: Plan = serde_json::from_value(json!({"resource_changes":[]})).unwrap();
    assert!(
        check_plan(&omitted, &BTreeMap::new(), &bindings)
            .unwrap()
            .is_empty()
    );
    assert!(check_plan(&omitted, &expected, &bindings).is_err());
}

#[test]
fn teardown_delegates_reconstructible_and_disposable_recovery_to_opentofu() {
    for address in [
        "nemoclaw_provider.example",
        "nemoclaw_provider_profile.example",
        "nemoclaw_pi_configuration.example",
        "docker_container.runtime",
    ] {
        let allowed = BTreeMap::from([(address.into(), Row::new())]);
        let bindings = BTreeMap::from([(
            address.into(),
            StateBinding {
                id: "previous".into(),
                ..Default::default()
            },
        )]);
        let empty: Plan = serde_json::from_value(json!({})).unwrap();
        // A committed refresh need not repeat absence in subsequent plans.
        assert!(
            check_destroy_plan(&empty, &allowed, &bindings, &BTreeSet::new())
                .unwrap()
                .is_empty()
        );
        let absent: Plan = serde_json::from_value(json!({
            "resource_drift": [{"address":address, "change":{"actions":["delete"], "before":{"id":"refreshed-object"}}}],
            "resource_changes": [{"address":address, "change":{"actions":["no-op"], "before":null, "after":null}}]
        })).unwrap();
        assert!(
            check_destroy_plan(&absent, &allowed, &bindings, &BTreeSet::new())
                .unwrap()
                .is_empty()
        );
        assert!(
            check_destroy_plan(&absent, &BTreeMap::new(), &bindings, &BTreeSet::new()).is_err()
        );
        for deposed in [None, Some("refreshed-key")] {
            let change = json!({"address":address, "deposed":deposed, "change":{"actions":["delete"], "before":{"id":"refreshed-object"}}});
            let plan: Plan = serde_json::from_value(json!({"resource_changes":[change]})).unwrap();
            assert_eq!(
                check_destroy_plan(&plan, &allowed, &bindings, &BTreeSet::new())
                    .unwrap()
                    .len(),
                1
            );
            assert!(
                check_destroy_plan(&plan, &BTreeMap::new(), &bindings, &BTreeSet::new()).is_err()
            );
            assert!(
                check_destroy_plan(
                    &plan,
                    &allowed,
                    &bindings,
                    &BTreeSet::from([address.into()])
                )
                .is_err()
            );
        }
        for actions in [
            json!(["create"]),
            json!(["update"]),
            json!(["delete", "create"]),
            json!(["forget"]),
        ] {
            let plan: Plan = serde_json::from_value(
                json!({"resource_changes":[{"address":address, "change":{"actions":actions}}]}),
            )
            .unwrap();
            assert!(check_destroy_plan(&plan, &allowed, &bindings, &BTreeSet::new()).is_err());
        }
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

#[cfg(unix)]
#[tokio::test]
async fn schema_commands_do_not_require_inference_credentials() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct Unavailable(AtomicUsize);
    impl Secrets for Unavailable {
        fn resolve(&self, _: &str) -> Result<String, crate::ObservationError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(crate::ObservationError::Authentication)
        }
    }
    let bundle_directory = tempfile::tempdir().unwrap();
    let bundle = Bundle {
        directory: bundle_directory.path().into(),
        manifest: crate::bundle::Manifest {
            version: "0.1.0".into(),
            rust: "fixture".into(),
            opentofu: crate::compile::OPENTOFU_VERSION.into(),
            files: BTreeMap::new(),
        },
    };
    fs::create_dir_all(bundle.tofu().parent().unwrap()).unwrap();
    fs::write(
        bundle.tofu(),
        b"#!/bin/sh\n[ \"$TF_IN_AUTOMATION\" = 1 ] && [ \"$TF_INPUT\" = 0 ] && [ \"$CHECKPOINT_DISABLE\" = 1 ] && [ \"$TF_CLI_CONFIG_FILE\" = \"$PWD/providers.tfrc\" ] || exit 1\nprintf '{}\\n'\n",
    )
    .unwrap();
    fs::set_permissions(bundle.tofu(), fs::Permissions::from_mode(0o700)).unwrap();
    let state_directory = tempfile::tempdir().unwrap();
    // macOS temporary paths may traverse /var -> /private/var; the shell's PWD
    // uses the physical directory when checking the fixture's environment.
    let state_path = state_directory.path().canonicalize().unwrap();
    let store = Store::open(&state_path).unwrap();
    let secrets = Arc::new(Unavailable::default());
    let deployment =
        Deployment::new(&state_path, bundle_directory.path()).with_secrets(secrets.clone());
    let mut document =
        Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes()).unwrap();
    document.spec.inference_providers[0].credential = Some(Credential {
        env: "TEST_INFERENCE_CREDENTIAL".into(),
    });
    let cancel = CancellationToken::new();
    for args in [
        vec!["init", "-input=false"],
        vec!["show", "-json", "apply.plan"],
    ] {
        assert_eq!(
            deployment
                .tofu(&bundle, &store, &document, &args, &cancel)
                .await
                .unwrap(),
            b"{}\n"
        );
    }
    assert_eq!(secrets.0.load(Ordering::SeqCst), 0);
    for operation in ["plan", "apply"] {
        assert!(
            deployment
                .tofu(&bundle, &store, &document, &[operation], &cancel)
                .await
                .is_err()
        );
    }
    assert_eq!(secrets.0.load(Ordering::SeqCst), 2);
}

#[test]
fn gateway_observation_resolves_only_gateway_credentials() {
    struct GatewayValues;
    impl Secrets for GatewayValues {
        fn resolve(&self, name: &str) -> Result<String, crate::ObservationError> {
            match name {
                "GATEWAY_TOKEN" | "GATEWAY_CA" | "GATEWAY_CERT" | "GATEWAY_KEY" => {
                    Ok(format!("test-{name}"))
                }
                _ => Err(crate::ObservationError::Authentication),
            }
        }
    }
    let mut document =
        Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes()).unwrap();
    document.spec.gateway = serde_json::from_value(json!({
        "management": "external",
        "endpoint": "https://gateway.example.com",
        "credential": {"env": "GATEWAY_TOKEN"},
        "tls": {
            "ca": {"env": "GATEWAY_CA"},
            "certificate": {"env": "GATEWAY_CERT"},
            "key": {"env": "GATEWAY_KEY"}
        }
    }))
    .unwrap();
    document.spec.inference_providers[0].credential = Some(Credential {
        env: "INFERENCE_TOKEN".into(),
    });
    document.spec.sandboxes[0].integrations = serde_json::from_value(json!({
        "search": {"kind": "webSearch", "provider": "brave", "credential": {"env": "SEARCH_KEY"}}
    }))
    .unwrap();
    document.spec.sandboxes[0].agent.integration_refs = vec!["search".into()];
    let environment = gateway_environment(&document, &GatewayValues, Path::new("state")).unwrap();
    for name in ["GATEWAY_TOKEN", "GATEWAY_CA", "GATEWAY_CERT", "GATEWAY_KEY"] {
        assert_eq!(environment[name], format!("test-{name}"));
    }
    assert!(!environment.contains_key("INFERENCE_TOKEN"));
    assert!(!environment.contains_key("SEARCH_KEY"));
    assert!(command_environment(&document, &GatewayValues, Path::new("state")).is_err());
    if let Gateway::External(gateway) = &mut document.spec.gateway {
        gateway.credential = Some(Credential {
            env: "TF_CLI_CONFIG_FILE".into(),
        });
    }
    assert!(matches!(
        gateway_environment(&document, &GatewayValues, Path::new("state")),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn gateway_replacement_preserves_the_old_binding_and_rejects_other_actions() {
    let address = "nemoclaw_managed_gateway.runtime";
    let expected = [(address.into(), Row::from([("spec".into(), "old".into())]))].into();
    let bindings = [(
        address.into(),
        StateBinding {
            id: "physical".into(),
            spec: "old".into(),
            ..Default::default()
        },
    )]
    .into();
    let plan:Plan = serde_json::from_value(json!({"resource_changes":[{"address":address,"change":{"actions":["delete","create"],"before":{"id":"physical","spec":"old"}}}]})).unwrap();
    assert_eq!(
        runtime::check_runtime_plan(&plan, &expected, &bindings)
            .unwrap()
            .len(),
        1
    );
    let mut wrong:Plan = serde_json::from_value(json!({"resource_changes":[{"address":address,"change":{"actions":["delete","create"],"before":{"id":"other","spec":"old"}}}]})).unwrap();
    assert!(runtime::check_runtime_plan(&wrong, &expected, &bindings).is_err());
    wrong.resource_changes.clear();
    assert!(runtime::check_runtime_plan(&wrong, &expected, &bindings).is_err());
    for action in [
        vec!["create"],
        vec!["delete"],
        vec!["forget"],
        vec!["create", "delete"],
    ] {
        let plan:Plan=serde_json::from_value(json!({"resource_changes":[{"address":address,"change":{"actions":action,"before":{"id":"physical","spec":"old"}}}]})).unwrap();
        assert!(runtime::check_runtime_plan(&plan, &expected, &bindings).is_err());
    }
}

#[tokio::test]
#[ignore = "creates and removes only an explicitly configured test gateway; retains its storage"]
async fn managed_gateway_plan_apply_noop_destroy_and_recovery_use_real_opentofu() {
    let path =
        |name| PathBuf::from(std::env::var_os(name).expect("explicit managed qualification path"));
    let mut document =
        Document::parse(fs::File::open(path("NEMOCLAW_TEST_GATEWAY_DOCUMENT")).unwrap()).unwrap();
    assert!(matches!(document.spec.gateway, Gateway::Managed(_)));
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
    let first = stage.bindings(&bundle.tofu(), &cancel).await.unwrap();
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
    let docker = document.spec.sandboxes[0].runtime.provider == ComputeDriver::Docker;
    let compute = if docker {
        "docker_container.managed_gateway_runtime"
    } else {
        "nemoclaw_managed_gateway.runtime"
    };
    assert_eq!(first.len(), if docker { 3 } else { 2 });
    let (changes, deferred, _, _) = deployment
        .runtime_stage(&bundle, &store, &document, &mut record, true, &cancel)
        .await
        .unwrap();
    assert!(changes.is_empty() && !deferred);
    let stage = Store::open(&store.directory.join("runtime")).unwrap();
    for (address, binding) in stage.bindings(&bundle.tofu(), &cancel).await.unwrap() {
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
                    .bindings(&bundle.tofu(), &cancel)
                    .await
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
            stage.bindings(&bundle.tofu(), &cancel).await.unwrap()["nemoclaw_gateway_storage.runtime"].id,
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
    // Reproduce a failed runtime apply after OpenTofu saved every declared
    // identity. Preview must remain read-only; destroy owns the recovery.
    record.begin_runtime_apply(&document);
    store.save(&record).unwrap();
    drop(store);
    let plan = deployment.plan_destroy(&cancel).await.unwrap();
    assert_eq!(plan.changes.len(), if docker { 2 } else { 1 });
    assert_eq!(plan.retained, vec!["nemoclaw_gateway_storage.runtime"]);
    let (_, store) = deployment.open().unwrap();
    assert!(store.load().unwrap().unwrap().pending());
    drop(store);
    deployment.destroy(&cancel).await.unwrap();
    assert!(engine.container(&name).await.unwrap().is_none());
    let (bundle, store) = deployment.open().unwrap();
    let mut record = store.load().unwrap().unwrap();
    assert!(!record.pending());
    deployment
        .runtime_stage(&bundle, &store, &document, &mut record, true, &cancel)
        .await
        .unwrap();
    let stage = Store::open(&store.directory.join("runtime")).unwrap();
    let recovered = stage.bindings(&bundle.tofu(), &cancel).await.unwrap();
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
            ..Default::default()
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
            runtime::check_runtime_plan(&plan, &allowed, &BTreeMap::new()).is_ok(),
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
            ..Default::default()
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
            ..Default::default()
        },
    )]
    .into();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address":storage,"change":{"actions":["create"],"before":null}}]})).unwrap();
    assert!(check_plan(&plan, &allowed, &bound).is_err());
}

#[test]
fn removed_disposable_compute_accepts_confirmed_absence() {
    let address = "docker_container.inference_service_model";
    let bindings = BTreeMap::from([(
        address.into(),
        StateBinding {
            id: "old-container".into(),
            ..Default::default()
        },
    )]);
    let plan: Plan = serde_json::from_value(json!({
        "resource_changes": [{"address": address, "change": {"actions": ["no-op"], "before": null, "after": null}}],
        "resource_drift": [{"address": address, "change": {"actions": ["delete"], "before": {"id": "old-container"}, "after": null}}]
    })).unwrap();
    assert!(
        check_plan(&plan, &BTreeMap::new(), &bindings)
            .unwrap()
            .is_empty()
    );
    assert!(
        runtime::check_runtime_plan(&plan, &BTreeMap::new(), &bindings)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn changing_gateway_management_at_the_same_endpoint_preserves_saved_state() {
    let bundle_directory = tempfile::tempdir().unwrap();
    let mut manifest = crate::bundle::Manifest {
        version: "0.1.0".into(),
        rust: "1.98.1".into(),
        opentofu: crate::compile::OPENTOFU_VERSION.into(),
        files: Default::default(),
    };
    // Valid bundle hashes let the request reach the state guard. These bytes
    // cannot execute, so a regression cannot start an actual deployment.
    for name in crate::bundle::required_files(&manifest.version).unwrap() {
        let path = bundle_directory.path().join(&name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"non-executable fixture").unwrap();
        manifest
            .files
            .insert(name, crate::bundle::hash_file(&path).unwrap());
    }
    fs::write(
        bundle_directory.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let external =
        Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes()).unwrap();
    let mut managed = external.clone();
    managed.spec.gateway = Gateway::Managed(crate::config::ManagedGateway {
        endpoint: external.spec.gateway.endpoint().into(),
        ..Default::default()
    });
    managed.defaults();
    managed.validate().unwrap();
    for (original, changed) in [(&external, &managed), (&managed, &external)] {
        let state_directory = tempfile::tempdir().unwrap();
        let store = Store::open(state_directory.path()).unwrap();
        store.save(&Record::new(original.clone()).unwrap()).unwrap();
        drop(store);
        let intent = state_directory.path().join("intent.json");
        let before = fs::read(&intent).unwrap();
        let deployment = Deployment::new(state_directory.path(), bundle_directory.path());
        for apply in [false, true] {
            let error = deployment
                .run(changed, &CancellationToken::new(), apply)
                .await
                .unwrap_err();
            assert!(matches!(
                error,
                Error::Conflict("state is bound to a different deployment UID or gateway")
            ));
            assert_eq!(fs::read(&intent).unwrap(), before);
        }
    }
}

#[test]
fn replacement_cleanup_reports_opentofu_objects_within_deployment_scope() {
    let address = "docker_container.runtime";
    let allowed = BTreeMap::from([(address.into(), Row::new())]);
    let bindings = BTreeMap::from([(
        address.into(),
        StateBinding {
            id: "current".into(),
            deposed: BTreeMap::from([("deadbeef".into(), "old".into())]),
            ..Default::default()
        },
    )]);
    let current =
        json!({"address":address,"change":{"actions":["no-op"],"before":{"id":"current"}}});
    let old = json!({"address":address,"deposed":"deadbeef","change":{"actions":["delete"],"before":{"id":"old"}}});
    let plan =
        |resources| serde_json::from_value::<Plan>(json!({"resource_changes":resources})).unwrap();
    let apply = plan(json!([current, old]));
    assert_eq!(check_plan(&apply, &allowed, &bindings).unwrap().len(), 1);
    assert_eq!(
        runtime::check_runtime_plan(&apply, &allowed, &bindings)
            .unwrap()
            .len(),
        1
    );
    assert!(export::settled(&bindings).is_err());
    let mut refreshed = old.clone();
    refreshed["deposed"] = json!("refreshed-key");
    refreshed["change"]["before"]["id"] = json!("refreshed-old-object");
    assert_eq!(
        check_plan(&plan(json!([current, refreshed])), &allowed, &bindings)
            .unwrap()
            .len(),
        1
    );
    let mut outside = old.clone();
    outside["address"] = json!("docker_container.foreign");
    assert!(check_plan(&plan(json!([current, outside])), &allowed, &bindings).is_err());
    assert!(check_plan(&plan(json!([current, old, old])), &allowed, &bindings).is_err());
    let mut delete = current.clone();
    delete["change"]["actions"] = json!(["delete"]);
    assert_eq!(
        check_destroy_plan(
            &plan(json!([delete, old])),
            &allowed,
            &bindings,
            &BTreeSet::new()
        )
        .unwrap()
        .len(),
        2
    );
    let mut only_old = bindings.clone();
    only_old.get_mut(address).unwrap().id.clear();
    assert_eq!(
        check_destroy_plan(&plan(json!([old])), &allowed, &only_old, &BTreeSet::new())
            .unwrap()
            .len(),
        1
    );
    // Refresh may confirm the old disposable object is already absent.
    let absent = json!({"address":address,"deposed":"deadbeef","change":{"actions":["no-op"],"before":null,"after":null}});
    assert!(
        check_plan(&plan(json!([current, absent])), &allowed, &bindings)
            .unwrap()
            .is_empty()
    );
    assert!(
        check_destroy_plan(
            &plan(json!([absent])),
            &allowed,
            &only_old,
            &BTreeSet::new()
        )
        .unwrap()
        .is_empty()
    );
    assert!(check_plan(&plan(json!([current])), &allowed, &bindings).is_ok());
    for durable in [
        "docker_volume.cache",
        "nemoclaw_inference_storage.credentials",
    ] {
        let bound = BTreeMap::from([(durable.into(), bindings[address].clone())]);
        let mut forbidden = old.clone();
        forbidden["address"] = json!(durable);
        assert!(
            check_destroy_plan(
                &plan(json!([forbidden])),
                &BTreeMap::from([(durable.into(), Row::new())]),
                &bound,
                &BTreeSet::from([durable.into()])
            )
            .is_err()
        );
    }
}

#[test]
fn managed_service_readiness_plans_require_the_declared_container() {
    let allowed = [("docker_container.managed_service_voice".into(), Row::new())].into();
    for (name, action, accepted) in [
        ("voice", "read", true),
        ("foreign", "read", false),
        ("voice", "create", false),
    ] {
        let plan: Plan = serde_json::from_value(json!({"resource_changes":[{
            "mode":"data", "address":format!("data.nemoclaw_service_readiness.managed_service_{name}"),
            "change":{"actions":[action]}
        }, {"address":"docker_container.managed_service_voice", "change":{"actions":["no-op"]}}]})).unwrap();
        assert_eq!(
            check_plan(&plan, &allowed, &BTreeMap::new()).is_ok(),
            accepted
        );
    }
}
