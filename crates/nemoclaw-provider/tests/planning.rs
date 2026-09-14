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
fn stopped_managed_process_plans_a_restart_without_promising_readiness_or_replacement() {
    for kind in ["managed_gateway", "inference_service"] {
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
fn unchanged_ollama_model_reuses_digest_but_a_model_change_reobserves_it() {
    let definition = Definition::new(
        "ollama_model",
        &["service_id", "endpoint", "model"],
        &["model"],
    );
    let prior = BTreeMap::from([
        ("id".into(), Value::Value("service/model".into())),
        ("service_id".into(), Value::Value("service".into())),
        (
            "endpoint".into(),
            Value::Value("http://127.0.0.1:11434/v1".into()),
        ),
        ("model".into(), Value::Value("qwen:small".into())),
        ("digest".into(), Value::Value("a".repeat(64))),
    ]);
    let mut proposed = prior.clone();
    proposed.insert("digest".into(), Value::Unknown);
    let (unchanged, replacements) = plan_update(&definition, &prior, proposed.clone());
    assert!(replacements.is_empty());
    assert_eq!(unchanged["digest"], prior["digest"]);
    proposed.insert("model".into(), Value::Value("qwen:large".into()));
    let (changed, replacements) = plan_update(&definition, &prior, proposed);
    assert!(replacements.is_empty());
    assert_eq!(changed["id"], prior["id"]);
    assert_eq!(changed["digest"], Value::Unknown);
}
