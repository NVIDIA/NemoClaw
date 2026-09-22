// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_provider::{Definition, plan_update};
use std::collections::BTreeMap;
use tf_provider::value::Value;

#[test]
fn unknown_id_reuses_state_and_only_immutable_fields_require_replacement() {
    let definition = Definition::new("provider", &["name", "endpoint"], &["endpoint"]);
    let prior = BTreeMap::from([
        ("id".into(), Value::Value("original-id".into())),
        ("name".into(), Value::Value("inference".into())),
        (
            "endpoint".into(),
            Value::Value("https://old.example/v1".into()),
        ),
    ]);
    let mut proposed = prior.clone();
    proposed.insert("id".into(), Value::Unknown);
    proposed.insert(
        "endpoint".into(),
        Value::Value("https://new.example/v1".into()),
    );
    let (planned, replacements) = plan_update(&definition, &prior, proposed.clone());
    assert_eq!(planned["id"], prior["id"]);
    assert!(replacements.is_empty());
    proposed.insert("name".into(), Value::Value("renamed".into()));
    let (_, replacements) = plan_update(&definition, &prior, proposed);
    assert_eq!(replacements, vec!["name"]);
}

#[test]
fn stopped_managed_process_reapplies_install_without_promising_readiness_or_replacement() {
    for kind in ["managed_gateway", "pi_configuration"] {
        let definition = Definition::new(kind, &["spec", "running"], &["running"]);
        for running in ["true", "false"] {
            let prior = BTreeMap::from([
                ("id".into(), Value::Value("durable".into())),
                ("spec".into(), Value::Value("pinned".into())),
                ("running".into(), Value::Value(running.into())),
            ]);
            let (planned, replacements) = plan_update(&definition, &prior, prior.clone());
            assert_eq!(planned["id"], prior["id"]);
            assert!(replacements.is_empty());
            assert_eq!(
                planned["running"],
                if running == "false" {
                    Value::Unknown
                } else {
                    prior["running"].clone()
                }
            );
        }
    }
}

#[test]
fn provider_authentication_mode_requires_replacement_but_reference_rotation_updates() {
    let definition = Definition::new(
        "provider",
        &["credential_env", "credential_source"],
        &["credential_env"],
    );
    for (before, after, replaces) in [
        ("", "API_KEY", true),
        ("API_KEY", "", true),
        ("OLD_KEY", "NEW_KEY", false),
    ] {
        let prior = BTreeMap::from([
            ("id".into(), Value::Value("registration".into())),
            ("credential_env".into(), Value::Value(before.into())),
            ("credential_source".into(), Value::Value(String::new())),
        ]);
        let mut desired = prior.clone();
        desired.insert("credential_env".into(), Value::Value(after.into()));
        let (_, replacements) = plan_update(&definition, &prior, desired);
        assert_eq!(
            replacements.contains(&"credential_env"),
            replaces,
            "{before:?} -> {after:?}"
        );
    }
}

#[test]
fn removed_service_kinds_do_not_override_configured_running_values() {
    for kind in ["inference_service", "ollama_service"] {
        let definition = Definition::new(kind, &["running"], &["running"]);
        let prior = BTreeMap::from([
            ("id".into(), Value::Value("existing".into())),
            ("running".into(), Value::Value("false".into())),
        ]);
        let mut proposed = prior.clone();
        proposed.insert("running".into(), Value::Value("true".into()));
        let (planned, replacements) = plan_update(&definition, &prior, proposed.clone());
        assert_eq!(planned, proposed);
        assert!(replacements.is_empty());
    }
}
