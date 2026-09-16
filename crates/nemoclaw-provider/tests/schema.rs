// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_provider::NemoClawProvider;
use tf_provider::{Diagnostics, Provider};

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
        "inference_service",
        "gateway_storage",
        "inference_storage",
    ] {
        assert!(resources.contains_key(name));
    }
    assert!(!resources.contains_key("route"));
    let schema = provider.schema(&mut diagnostics).unwrap();
    for name in [
        "endpoint",
        "credential_env",
        "tls_ca_env",
        "tls_certificate_env",
        "tls_key_env",
        "ollama_engine",
        "destroy",
    ] {
        assert!(schema.block.attributes.contains_key(name));
    }
    assert!(diagnostics.errors.is_empty());
}
