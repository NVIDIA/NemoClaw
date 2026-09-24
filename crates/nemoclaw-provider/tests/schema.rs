// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_provider::NemoClawProvider;
use tf_provider::{Diagnostics, Provider};

#[test]
fn service_capacity_is_exposed_as_read_only_data() {
    use tf_provider::schema::AttributeConstraint;
    let mut diagnostics = Diagnostics::default();
    let sources = NemoClawProvider::default()
        .get_data_sources(&mut diagnostics)
        .unwrap();
    let schema = sources
        .get("service_capacity")
        .expect("combined capacity data source")
        .schema(&mut diagnostics)
        .unwrap();
    for field in ["engine", "specs"] {
        assert!(matches!(
            schema.block.attributes[field].constraint,
            AttributeConstraint::Required
        ));
    }
    for field in ["required_bytes", "observed_bytes", "compatible"] {
        assert!(matches!(
            schema.block.attributes[field].constraint,
            AttributeConstraint::Computed
        ));
    }
    assert!(diagnostics.errors.is_empty());
}

#[test]
fn gateway_capabilities_are_exposed_as_read_only_data() {
    use tf_provider::schema::AttributeConstraint;
    let mut diagnostics = Diagnostics::default();
    let sources = NemoClawProvider::default()
        .get_data_sources(&mut diagnostics)
        .unwrap();
    let source = sources
        .get("gateway_capabilities")
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
fn production_provider_exposes_the_existing_openshell_resource_addresses() {
    let provider = NemoClawProvider::default();
    let mut diagnostics = Diagnostics::default();
    let resources = provider.get_resources(&mut diagnostics).unwrap();
    for name in [
        "workspace",
        "provider",
        "provider_profile",
        "sandbox",
        "managed_gateway",
        "gateway_storage",
        "inference_storage",
    ] {
        assert!(resources.contains_key(name));
    }
    for removed in [
        "route",
        "inference_service",
        "ollama_service",
        "ollama_proxy",
    ] {
        assert!(!resources.contains_key(removed));
    }
    let profile = resources["provider_profile"]
        .schema(&mut diagnostics)
        .unwrap();
    for name in ["endpoint", "authenticated"] {
        assert!(
            matches!(
                profile.block.attributes[name].constraint,
                tf_provider::schema::AttributeConstraint::OptionalComputed
            ),
            "native inference fields must be optional for the Brave profile"
        );
    }
    let inference = resources["provider"].schema(&mut diagnostics).unwrap();
    assert!(matches!(
        inference.block.attributes["endpoint"].constraint,
        tf_provider::schema::AttributeConstraint::Required
    ));
    let schema = provider.schema(&mut diagnostics).unwrap();
    for name in [
        "endpoint",
        "credential_env",
        "tls_ca_env",
        "tls_certificate_env",
        "tls_key_env",
        "destroy",
    ] {
        assert!(schema.block.attributes.contains_key(name));
    }
    assert!(!schema.block.attributes.contains_key("ollama_engine"));
    assert!(diagnostics.errors.is_empty());
}

#[test]
fn gateway_storage_exports_its_verified_mountpoint() {
    let mut diagnostics = Diagnostics::default();
    let resources = NemoClawProvider::default()
        .get_resources(&mut diagnostics)
        .unwrap();
    let schema = resources["gateway_storage"]
        .schema(&mut diagnostics)
        .unwrap();
    assert!(matches!(
        schema.block.attributes["data_path"].constraint,
        tf_provider::schema::AttributeConstraint::Computed
    ));
    assert!(diagnostics.errors.is_empty());
}

#[test]
fn registered_resources_compute_only_owned_observations_and_require_model_digest() {
    use tf_provider::schema::AttributeConstraint;
    let mut diagnostics = Diagnostics::default();
    let resources = NemoClawProvider::default()
        .get_resources(&mut diagnostics)
        .unwrap();
    for (kind, resource) in &resources {
        let schema = resource.schema(&mut diagnostics).unwrap();
        let running = schema.block.attributes.get("running");
        assert_eq!(
            running.is_some(),
            matches!(kind.as_str(), "managed_gateway" | "agent_configuration"),
            "{kind}"
        );
        if let Some(running) = running {
            assert!(matches!(running.constraint, AttributeConstraint::Computed));
        }
        let digest = schema.block.attributes.get("digest");
        assert_eq!(digest.is_some(), kind == "ollama_external_model", "{kind}");
        if let Some(digest) = digest {
            assert!(matches!(digest.constraint, AttributeConstraint::Required));
        }
    }
    assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
}

#[test]
fn engine_discovery_is_available_without_a_gateway() {
    use tf_provider::schema::AttributeConstraint;
    let provider = NemoClawProvider::default();
    let mut diagnostics = Diagnostics::default();
    let sources = provider.get_data_sources(&mut diagnostics).unwrap();
    for kind in ["engine_capabilities", "fabric_capabilities"] {
        let schema = sources
            .get(kind)
            .expect("read-only discovery data source")
            .schema(&mut diagnostics)
            .unwrap();
        assert!(matches!(
            schema.block.attributes["observation_json"].constraint,
            AttributeConstraint::Computed
        ));
    }
    assert!(matches!(
        provider.schema(&mut diagnostics).unwrap().block.attributes["endpoint"].constraint,
        AttributeConstraint::Optional
    ));
}

#[test]
fn inference_discovery_keeps_credentials_as_optional_references() {
    use tf_provider::schema::AttributeConstraint;
    let mut diagnostics = Diagnostics::default();
    let sources = NemoClawProvider::default()
        .get_data_sources(&mut diagnostics)
        .unwrap();
    let schema = sources
        .get("inference_capabilities")
        .expect("inference model catalog data source")
        .schema(&mut diagnostics)
        .unwrap();
    assert!(matches!(
        schema.block.attributes["credential_env"].constraint,
        AttributeConstraint::Optional
    ));
    assert!(matches!(
        schema.block.attributes["observation_json"].constraint,
        AttributeConstraint::Computed
    ));
    assert!(!schema.block.attributes.contains_key("credential"));
}

#[test]
fn gateway_capabilities_include_typed_discovery_output() {
    let mut diagnostics = Diagnostics::default();
    let sources = NemoClawProvider::default()
        .get_data_sources(&mut diagnostics)
        .unwrap();
    let schema = sources["gateway_capabilities"]
        .schema(&mut diagnostics)
        .unwrap();
    assert!(schema.block.attributes.contains_key("observation_json"));
    assert!(schema.block.attributes.contains_key("status"));
}
