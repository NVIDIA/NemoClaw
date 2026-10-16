// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `openshell` provider's schema. `tests/schema.txt` records every type's
//! attributes; these tests check that snapshot and the rules across types.

use openshell_provider::OpenShellProvider;
use std::path::Path;
use tf_provider::{Diagnostics, Provider, schema::AttributeConstraint};

#[test]
fn schema_matches_the_checked_in_snapshot() {
    nemoclaw_test_fixtures::schema::assert_snapshot(
        "openshell",
        &OpenShellProvider::default(),
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/schema.txt"),
        "cargo test -p openshell-provider --test schema",
    );
}

/// Every resource generates an omitted generation, and an omitted owner
/// unless a reference carries it, as a workspace reference carries its owner.
#[test]
fn every_resource_generates_or_carries_its_owner_and_generation() {
    let mut diagnostics = Diagnostics::default();
    let resources = OpenShellProvider::default()
        .get_resources(&mut diagnostics)
        .unwrap();
    for (kind, resource) in &resources {
        let schema = resource.schema(&mut diagnostics).unwrap();
        for attribute in ["owner", "generation"] {
            if attribute == "owner" && !schema.block.attributes.contains_key("owner") {
                assert!(
                    nemoclaw_openshell::references(kind)
                        .iter()
                        .any(|reference| reference
                            .fields
                            .iter()
                            .any(|(_, field)| *field == "owner")),
                    "{kind}.owner must be generated or carried by a reference"
                );
                continue;
            }
            assert!(
                matches!(
                    schema
                        .block
                        .attributes
                        .get(attribute)
                        .map(|a| &a.constraint),
                    Some(AttributeConstraint::OptionalComputed)
                ),
                "{kind}.{attribute} must be optional and computed"
            );
        }
    }
    assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
}
