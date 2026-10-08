// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `fabric` provider's configuration, resource, and data source schemas.

use fabric_provider::FabricProvider;
use tf_provider::{Diagnostics, Provider, schema::AttributeConstraint};

#[test]
fn provider_serves_agent_configuration_and_sandbox_readiness_through_a_gateway() {
    let provider = FabricProvider::default();
    let mut diagnostics = Diagnostics::default();
    let resources = provider.get_resources(&mut diagnostics).unwrap();
    assert_eq!(
        resources.keys().collect::<Vec<_>>(),
        ["agent_configuration"]
    );
    let sources = provider.get_data_sources(&mut diagnostics).unwrap();
    assert_eq!(sources.keys().collect::<Vec<_>>(), ["sandbox_readiness"]);
    let readiness = sources["sandbox_readiness"]
        .schema(&mut diagnostics)
        .unwrap();
    for output in ["ready", "health_json", "error_message"] {
        assert!(
            matches!(
                readiness.block.attributes[output].constraint,
                AttributeConstraint::Computed
            ),
            "{output}"
        );
    }
    // The same gateway settings as the openshell provider.
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
