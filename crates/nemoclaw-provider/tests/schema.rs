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
    for field in ["engine", "contracts"] {
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
fn production_provider_serves_platform_resources_but_not_openshell_objects() {
    let provider = NemoClawProvider::default();
    let mut diagnostics = Diagnostics::default();
    let resources = provider.get_resources(&mut diagnostics).unwrap();
    for name in [
        "agent_configuration",
        "managed_gateway",
        "gateway_storage",
        "inference_storage",
        "kubernetes_storage",
        "kubernetes_auth",
        "kubernetes_gateway",
    ] {
        assert!(resources.contains_key(name), "{name}");
    }
    for name in ["workspace", "provider", "provider_profile", "sandbox"] {
        assert!(!resources.contains_key(name), "{name}");
    }
    let sources = provider.get_data_sources(&mut diagnostics).unwrap();
    assert!(!sources.contains_key("gateway_capabilities"));
    let schema = provider.schema(&mut diagnostics).unwrap();
    for name in [
        "endpoint",
        "credential_env",
        "tls_ca_env",
        "tls_certificate_env",
        "tls_key_env",
        "destroy",
        "platform_only",
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
            matches!(
                kind.as_str(),
                "managed_gateway"
                    | "agent_configuration"
                    | "kubernetes_storage"
                    | "kubernetes_auth"
                    | "kubernetes_gateway"
            ),
            "{kind}"
        );
        if let Some(running) = running {
            assert!(matches!(running.constraint, AttributeConstraint::Computed));
        }
        let release_present = schema.block.attributes.get("release_present");
        assert_eq!(
            release_present.is_some(),
            kind == "kubernetes_auth",
            "{kind}"
        );
        if let Some(release_present) = release_present {
            assert!(matches!(
                release_present.constraint,
                AttributeConstraint::Computed
            ));
        }
        let gateway_values = schema.block.attributes.get("gateway_values");
        assert_eq!(
            gateway_values.is_some(),
            kind == "kubernetes_auth",
            "{kind}"
        );
        if let Some(gateway_values) = gateway_values {
            assert!(matches!(
                gateway_values.constraint,
                AttributeConstraint::Computed
            ));
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
fn ollama_proxy_identity_is_optional_and_computed() {
    let provider = NemoClawProvider::default();
    let mut diagnostics = Diagnostics::default();
    let resources = provider.get_resources(&mut diagnostics).unwrap();
    for kind in ["ollama_proxy_storage", "ollama_external_model"] {
        let schema = resources[kind].schema(&mut diagnostics).unwrap();
        for attribute in ["owner", "generation"] {
            assert!(
                matches!(
                    schema.block.attributes[attribute].constraint,
                    tf_provider::schema::AttributeConstraint::OptionalComputed
                ),
                "{kind}.{attribute}"
            );
        }
    }
    assert!(diagnostics.errors.is_empty());
}

#[test]
fn managed_gateway_resources_take_typed_settings() {
    use tf_provider::schema::AttributeConstraint::{OptionalComputed, Required};
    let provider = NemoClawProvider::default();
    let mut diagnostics = Diagnostics::default();
    let resources = provider.get_resources(&mut diagnostics).unwrap();
    for (kind, endpoint) in [("managed_gateway", true), ("gateway_storage", false)] {
        let schema = resources[kind].schema(&mut diagnostics).unwrap();
        let attributes = &schema.block.attributes;
        assert!(!attributes.contains_key("spec"), "{kind}");
        for attribute in ["name", "compute_driver", "engine", "image", "network_cidr"] {
            assert!(
                matches!(attributes[attribute].constraint, Required),
                "{kind}.{attribute}"
            );
        }
        for attribute in ["owner", "generation"] {
            assert!(
                matches!(attributes[attribute].constraint, OptionalComputed),
                "{kind}.{attribute}"
            );
        }
        assert!(
            matches!(
                (&attributes["endpoint"].constraint, endpoint),
                (Required, true) | (OptionalComputed, false)
            ),
            "{kind}.endpoint"
        );
    }
    assert!(diagnostics.errors.is_empty());
}

#[test]
fn service_observations_take_typed_inputs_instead_of_compiled_specs() {
    use tf_provider::schema::AttributeConstraint::{Optional, Required};
    let mut diagnostics = Diagnostics::default();
    let sources = NemoClawProvider::default()
        .get_data_sources(&mut diagnostics)
        .unwrap();
    for (source, required, optional) in [
        (
            "runtime_image",
            &["engine", "image", "architecture"][..],
            &["labels", "image_id", "allow_missing"][..],
        ),
        (
            "service_readiness",
            &["engine", "name", "contract", "container_id"][..],
            &["wait_timeout_seconds", "read_trigger"][..],
        ),
        ("service_capacity", &["engine", "contracts"][..], &[][..]),
    ] {
        let schema = sources[source].schema(&mut diagnostics).unwrap();
        let attributes = &schema.block.attributes;
        assert!(!attributes.contains_key("spec"), "{source}");
        for attribute in required {
            assert!(
                matches!(attributes[*attribute].constraint, Required),
                "{source}.{attribute}"
            );
        }
        for attribute in optional {
            assert!(
                matches!(attributes[*attribute].constraint, Optional),
                "{source}.{attribute}"
            );
        }
    }
    assert!(diagnostics.errors.is_empty());
}
