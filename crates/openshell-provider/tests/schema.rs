// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `openshell` provider's configuration, resource, and data source schemas.

use openshell_provider::OpenShellProvider;
use tf_provider::{Diagnostics, Provider, schema::AttributeConstraint};

#[test]
fn provider_serves_openshell_objects_under_their_resource_names() {
    let provider = OpenShellProvider::default();
    let mut diagnostics = Diagnostics::default();
    let resources = provider.get_resources(&mut diagnostics).unwrap();
    let mut names: Vec<_> = resources.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "provider_profile",
            "provider_registration",
            "sandbox",
            "workspace"
        ]
    );
    let profile = resources["provider_profile"]
        .schema(&mut diagnostics)
        .unwrap();
    for name in ["endpoint", "authenticated"] {
        assert!(
            matches!(
                profile.block.attributes[name].constraint,
                AttributeConstraint::OptionalComputed
            ),
            "native inference fields must be optional for the Brave profile"
        );
    }
    let sandbox = resources["sandbox"].schema(&mut diagnostics).unwrap();
    assert!(sandbox.block.blocks.contains_key("policy"));
    for (name, attribute) in [
        (
            "provider_names",
            &sandbox.block.attributes["provider_names"],
        ),
        ("owner", &sandbox.block.attributes["owner"]),
        ("generation", &sandbox.block.attributes["generation"]),
        ("binaries", &profile.block.attributes["binaries"]),
    ] {
        assert!(
            !matches!(
                attribute.attr_type,
                tf_provider::schema::AttributeType::String
            ) || matches!(attribute.constraint, AttributeConstraint::OptionalComputed),
            "{name}"
        );
    }
    for json in ["policy_json", "provider_names_json"] {
        assert!(!sandbox.block.attributes.contains_key(json), "{json}");
    }
    assert!(!profile.block.attributes.contains_key("binaries_json"));
    let registration = resources["provider_registration"]
        .schema(&mut diagnostics)
        .unwrap();
    assert!(matches!(
        registration.block.attributes["endpoint"].constraint,
        AttributeConstraint::Required
    ));
    let schema = provider.schema(&mut diagnostics).unwrap();
    let mut attributes: Vec<_> = schema.block.attributes.keys().map(String::as_str).collect();
    attributes.sort_unstable();
    assert_eq!(
        attributes,
        [
            "credential_env",
            "destroy",
            "endpoint",
            "tls_ca_env",
            "tls_certificate_env",
            "tls_key_env"
        ]
    );
    assert!(diagnostics.errors.is_empty());
}

#[test]
fn gateway_capabilities_are_exposed_as_read_only_data() {
    let mut diagnostics = Diagnostics::default();
    let sources = OpenShellProvider::default()
        .get_data_sources(&mut diagnostics)
        .unwrap();
    let source = sources
        .get("gateway")
        .expect("gateway observation data source");
    let schema = source.schema(&mut diagnostics).unwrap();
    assert!(matches!(
        schema.block.attributes["required_compute_drivers"].constraint,
        AttributeConstraint::Required
    ));
    for field in [
        "gateway_version",
        "compute_drivers",
        "compatible",
        "incompatibility",
    ] {
        assert!(matches!(
            schema.block.attributes[field].constraint,
            AttributeConstraint::Computed
        ));
    }
    assert!(diagnostics.errors.is_empty());
}

#[test]
fn gateway_capabilities_include_typed_discovery_output() {
    let mut diagnostics = Diagnostics::default();
    let sources = OpenShellProvider::default()
        .get_data_sources(&mut diagnostics)
        .unwrap();
    let schema = sources["gateway"].schema(&mut diagnostics).unwrap();
    assert!(schema.block.attributes.contains_key("observation_json"));
    assert!(schema.block.attributes.contains_key("status"));
}
