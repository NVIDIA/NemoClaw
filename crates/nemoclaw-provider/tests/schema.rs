// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `nemoclaw` provider's schema. `tests/schema.txt` records every type's
//! attributes; these tests check that snapshot and the rules across types.

use fabric_provider::FabricProvider;
use nemoclaw_provider::{NemoClawProvider, ServiceProvider};
use openshell_provider::OpenShellProvider;
use std::{collections::BTreeSet, path::Path};
use tf_provider::{Diagnostics, DynamicProvider, schema::AttributeConstraint};

#[test]
fn schema_matches_the_checked_in_snapshot() {
    nemoclaw_test_fixtures::schema::assert_snapshot(
        "nemoclaw",
        &NemoClawProvider::default(),
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/schema.txt"),
        "cargo test -p nemoclaw-provider --test integration schema::",
    );
}

#[test]
fn runtime_provider_schemas_match_their_snapshots() {
    for (name, provider) in [
        ("vllm", ServiceProvider::vllm()),
        ("ollama", ServiceProvider::ollama()),
    ] {
        nemoclaw_test_fixtures::schema::assert_snapshot(
            name,
            &provider,
            &Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/schema-{name}.txt")),
            "cargo test -p nemoclaw-provider --test integration schema::",
        );
    }
}

fn type_names(provider: &dyn DynamicProvider) -> BTreeSet<String> {
    let mut diagnostics = Diagnostics::default();
    let resources = provider.get_resources(&mut diagnostics).unwrap();
    let sources = provider.get_data_sources(&mut diagnostics).unwrap();
    assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
    resources.into_keys().chain(sources.into_keys()).collect()
}

#[test]
fn no_type_name_is_served_by_two_providers() {
    // OpenShell objects and Fabric agents belong to their own providers; a
    // type with the same name here would be a second implementation of it.
    let nemoclaw = type_names(&NemoClawProvider::default());
    for (name, other) in [
        ("openshell", type_names(&OpenShellProvider::default())),
        ("fabric", type_names(&FabricProvider::default())),
    ] {
        let shared: Vec<_> = nemoclaw.intersection(&other).collect();
        assert!(
            shared.is_empty(),
            "nemoclaw and {name} both serve {shared:?}"
        );
    }
}

#[test]
fn every_resource_generates_an_omitted_owner_and_generation() {
    let mut diagnostics = Diagnostics::default();
    let providers: [&dyn DynamicProvider; 3] = [
        &NemoClawProvider::default(),
        &ServiceProvider::vllm(),
        &ServiceProvider::ollama(),
    ];
    let resources: Vec<_> = providers
        .iter()
        .flat_map(|provider| provider.get_resources(&mut diagnostics).unwrap())
        .collect();
    for (kind, resource) in &resources {
        let schema = resource.schema(&mut diagnostics).unwrap();
        for attribute in ["owner", "generation"] {
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
