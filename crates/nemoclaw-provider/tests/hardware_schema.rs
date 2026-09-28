// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_provider::NemoClawProvider;
use tf_provider::{Diagnostics, Provider, schema::AttributeConstraint};

#[test]
fn target_hardware_is_read_only_and_requires_only_the_selected_engine() {
    let mut diagnostics = Diagnostics::default();
    let sources = NemoClawProvider::default()
        .get_data_sources(&mut diagnostics)
        .unwrap();
    let schema = sources
        .get("target_hardware")
        .expect("target hardware data source")
        .schema(&mut diagnostics)
        .unwrap();
    assert!(matches!(
        schema.block.attributes["engine"].constraint,
        AttributeConstraint::Required
    ));
    for field in ["status", "available", "observation_json"] {
        assert!(matches!(
            schema.block.attributes[field].constraint,
            AttributeConstraint::Computed
        ));
    }
    assert!(!schema.block.attributes.contains_key("probe"));
    assert!(!schema.block.attributes.contains_key("image"));
    assert!(diagnostics.errors.is_empty());
}
