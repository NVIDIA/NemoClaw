// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `fabric` provider's schema. `tests/schema.txt` records every type's
//! attributes; these tests check that snapshot and the rules it shares with
//! the `openshell` provider.

use fabric_provider::FabricProvider;
use openshell_provider::OpenShellProvider;
use std::{collections::BTreeMap, path::Path};
use tf_provider::{Diagnostics, DynamicProvider};

#[test]
fn schema_matches_the_checked_in_snapshot() {
    nemoclaw_test_fixtures::schema::assert_snapshot(
        "fabric",
        &FabricProvider::default(),
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/schema.txt"),
        "cargo test -p fabric-provider --test schema",
    );
}

/// Each configuration attribute's type and constraint, without descriptions.
fn configuration(provider: &dyn DynamicProvider) -> BTreeMap<String, String> {
    let mut diagnostics = Diagnostics::default();
    let schema = provider.schema(&mut diagnostics).unwrap();
    assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
    schema
        .block
        .attributes
        .into_iter()
        .map(|(name, attribute)| {
            let shape = format!("{} {:?}", attribute.attr_type, attribute.constraint);
            (name, shape)
        })
        .collect()
}

#[test]
fn provider_takes_the_same_gateway_settings_as_the_openshell_provider() {
    // Both providers reach the same gateway, so one deployment configures them
    // with the same values.
    assert_eq!(
        configuration(&FabricProvider::default()),
        configuration(&OpenShellProvider::default())
    );
}
