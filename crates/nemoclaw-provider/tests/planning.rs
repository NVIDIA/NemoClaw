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
