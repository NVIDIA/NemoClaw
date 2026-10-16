// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The schemas of the providers this package serves. `tests/schema-*.txt`
//! record every type's attributes; these tests check those snapshots and the
//! rules across types.

use nemoclaw_provider::{HostProvider, ServiceProvider};
use std::path::Path;
use tf_provider::{Diagnostics, DynamicProvider, schema::AttributeConstraint};

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
    nemoclaw_test_fixtures::schema::assert_snapshot(
        "host",
        &HostProvider::default(),
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/schema-host.txt"),
        "cargo test -p nemoclaw-provider --test integration schema::",
    );
}

#[test]
fn every_resource_generates_an_omitted_owner_and_generation() {
    let mut diagnostics = Diagnostics::default();
    let providers: [&dyn DynamicProvider; 2] =
        [&ServiceProvider::vllm(), &ServiceProvider::ollama()];
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
