// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

const BUNDLE_VERSION: &str = "0.1.0-dev.recovery-fixture";

fn native_state() -> Value {
    json!({
        "version": 4, "lineage": "original-runtime", "serial": 8,
        "resources": [{
            "mode": "managed", "type": "helm_release", "name": "gateway",
            "provider": "provider[\"registry.opentofu.org/hashicorp/helm\"]",
            "instances": [{"schema_version": 3, "attributes": {"id": "gateway"}}],
        }],
    })
}

fn checkpoint() -> (Record, Checkpoint) {
    let (document, _) = crate::deployment::tests::kubernetes_context();
    let mut record = Record::new(document).unwrap();
    record.begin_destroy();
    let checkpoint = Checkpoint {
        version: 1,
        bundle: BUNDLE_VERSION.into(),
        intent: record.document.digest(),
        generations: record.generations.clone(),
        state: native_state().to_string(),
    };
    (record, checkpoint)
}

#[test]
fn recovery_accepts_only_the_same_state_lineage_at_an_equal_or_later_serial() {
    let (record, checkpoint) = checkpoint();
    for serial in [8, 9, 20] {
        let mut current = native_state();
        current["serial"] = json!(serial);
        checkpoint
            .validate(BUNDLE_VERSION, &record, &current.to_string())
            .unwrap();
    }
}

#[test]
fn recovery_requires_the_original_default_helm_provider_configuration() {
    for field in [
        "foreign-provider",
        "aliased-provider",
        "missing-provider",
        "module",
        "mode",
        "multiple-resources",
        "multiple-instances",
        "indexed-instance",
    ] {
        let (record, mut checkpoint) = checkpoint();
        let mut changed = native_state();
        match field {
            "foreign-provider" => {
                changed["resources"][0]["provider"] =
                    json!("provider[\"registry.opentofu.org/foreign/helm\"]")
            }
            "aliased-provider" => {
                changed["resources"][0]["provider"] =
                    json!("provider[\"registry.opentofu.org/hashicorp/helm\"].other")
            }
            "missing-provider" => {
                changed["resources"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("provider");
            }
            "module" => changed["resources"][0]["module"] = json!("module.foreign"),
            "mode" => changed["resources"][0]["mode"] = json!("data"),
            "multiple-resources" => {
                let duplicate = changed["resources"][0].clone();
                changed["resources"].as_array_mut().unwrap().push(duplicate);
            }
            "multiple-instances" => {
                let duplicate = changed["resources"][0]["instances"][0].clone();
                changed["resources"][0]["instances"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "indexed-instance" => changed["resources"][0]["instances"][0]["index_key"] = json!(0),
            _ => unreachable!(),
        }
        assert!(
            checkpoint
                .validate(BUNDLE_VERSION, &record, &changed.to_string())
                .is_err(),
            "current {field}"
        );
        let current = checkpoint.state.clone();
        checkpoint.state = changed.to_string();
        assert!(
            checkpoint
                .validate(BUNDLE_VERSION, &record, &current)
                .is_err(),
            "saved {field}"
        );
    }
}

#[test]
fn the_saved_state_requires_a_release_but_the_current_state_may_have_lost_it() {
    let (record, mut checkpoint) = checkpoint();
    let mut absent = native_state();
    absent["resources"] = json!([]);
    checkpoint
        .validate(BUNDLE_VERSION, &record, &absent.to_string())
        .unwrap();
    let current = checkpoint.state.clone();
    checkpoint.state = absent.to_string();
    assert!(
        checkpoint
            .validate(BUNDLE_VERSION, &record, &current)
            .is_err()
    );
}

#[test]
fn a_completed_destroy_or_reapply_cannot_replay_the_recovery_checkpoint() {
    let (mut record, checkpoint) = checkpoint();
    record.finish_destroy();
    assert!(
        checkpoint
            .validate(BUNDLE_VERSION, &record, &checkpoint.state)
            .is_err()
    );
    record.begin_runtime_apply(&record.document.clone());
    assert!(
        checkpoint
            .validate(BUNDLE_VERSION, &record, &checkpoint.state)
            .is_err()
    );
}

#[test]
fn recovery_rejects_changed_intent_generations_bundle_and_checkpoint_version() {
    for field in ["intent", "generations", "bundle", "version"] {
        let (record, mut checkpoint) = checkpoint();
        match field {
            "intent" => checkpoint.intent = "different-intent".into(),
            "generations" => {
                checkpoint
                    .generations
                    .insert(crate::kubernetes::GATEWAY_KIND.into(), "b".repeat(32));
            }
            "bundle" => checkpoint.bundle = "different-bundle".into(),
            "version" => checkpoint.version = 2,
            _ => unreachable!(),
        }
        assert!(
            checkpoint
                .validate(BUNDLE_VERSION, &record, &checkpoint.state)
                .is_err(),
            "{field}"
        );
    }
}

#[test]
fn recovery_rejects_invalid_or_replaced_saved_and_current_state_headers() {
    let invalid = [
        json!({"version": 5, "lineage": "original-runtime", "serial": 8}),
        json!({"version": 4, "lineage": "", "serial": 8}),
        json!({"version": 4, "serial": 8}),
        json!({"version": 4, "lineage": "original-runtime", "serial": -1}),
        json!({"version": 4, "lineage": "original-runtime", "serial": "8"}),
        json!({"version": 4, "lineage": "original-runtime"}),
    ];
    for state in invalid.iter().map(Value::to_string).chain(["{".into()]) {
        let (record, mut checkpoint) = checkpoint();
        assert!(
            checkpoint
                .validate(BUNDLE_VERSION, &record, &state)
                .is_err(),
            "invalid current state header"
        );
        let current = checkpoint.state.clone();
        checkpoint.state = state;
        assert!(
            checkpoint
                .validate(BUNDLE_VERSION, &record, &current)
                .is_err(),
            "invalid saved state header"
        );
    }
    let (record, checkpoint) = checkpoint();
    for current in [
        json!({"version": 4, "lineage": "replacement-runtime", "serial": 9}),
        json!({"version": 4, "lineage": "original-runtime", "serial": 7}),
    ] {
        assert!(
            checkpoint
                .validate(BUNDLE_VERSION, &record, &current.to_string())
                .is_err(),
            "lineage changed or serial regressed"
        );
    }
}

fn saved() -> BTreeMap<String, StateBinding> {
    [
        (KUBERNETES_STORAGE, "namespace-uid", "storage-spec"),
        (KUBERNETES_AUTH, "issuer-uid", "auth-spec"),
        (crate::kubernetes::gateway::ADDRESS, "gateway", ""),
        (
            "nemoclaw_kubernetes_gateway.runtime",
            "gateway-uid",
            "gateway-spec",
        ),
    ]
    .into_iter()
    .map(|(address, id, spec)| {
        (
            address.into(),
            StateBinding {
                id: id.into(),
                spec: spec.into(),
                ..Default::default()
            },
        )
    })
    .collect()
}

#[test]
fn a_forgotten_release_is_restored_without_resurrecting_removed_readiness() {
    let saved = saved();
    let mut current = saved.clone();
    current.remove(crate::kubernetes::gateway::ADDRESS);
    current.remove("nemoclaw_kubernetes_gateway.runtime");
    assert!(needs_restore(&saved, &current).unwrap());
}

#[test]
fn successful_auth_removal_confirms_absence_and_does_not_restore_the_release() {
    let saved = saved();
    let current = BTreeMap::from([(KUBERNETES_STORAGE.into(), saved[KUBERNETES_STORAGE].clone())]);
    assert!(!needs_restore(&saved, &current).unwrap());
    assert!(!needs_restore(&saved, &saved).unwrap());
}

#[test]
fn recovery_rejects_missing_storage_changed_identity_and_unexpected_resources() {
    let saved = saved();
    for address in saved.keys() {
        for field in [
            "id",
            "spec",
            "name",
            "namespace",
            "chart",
            "owner",
            "generation",
            "workspace",
            "deposed",
        ] {
            let mut current = saved.clone();
            let binding = current.get_mut(address).unwrap();
            match field {
                "id" => binding.id = "foreign".into(),
                "spec" => binding.spec = "foreign".into(),
                "name" => binding.name = "foreign".into(),
                "namespace" => binding.namespace = "foreign".into(),
                "chart" => binding.chart = "foreign".into(),
                "owner" => binding.owner = "foreign".into(),
                "generation" => binding.generation = "foreign".into(),
                "workspace" => binding.workspace = "foreign".into(),
                "deposed" => {
                    binding.deposed.insert("replaced".into(), "foreign".into());
                }
                _ => unreachable!(),
            }
            assert!(
                needs_restore(&saved, &current).is_err(),
                "{address}: {field}"
            );
        }
    }
    let mut current = saved.clone();
    current.remove(KUBERNETES_STORAGE);
    assert!(needs_restore(&saved, &current).is_err());
    let mut current = saved.clone();
    current.insert("foreign.resource".into(), StateBinding::default());
    assert!(needs_restore(&saved, &current).is_err());
    let mut current = saved.clone();
    current.remove(KUBERNETES_AUTH);
    assert!(needs_restore(&saved, &current).is_err());
}
