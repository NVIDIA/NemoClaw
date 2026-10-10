// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Contract tests: each nemoclaw type through pinned OpenTofu against fake
//! Docker engines, gateways, and model servers. `every_type_has_a_contract_test`
//! requires one for every type the provider serves.

#[path = "../../../test-support/http.rs"]
mod http_fixture;
/// Fabric catalog fixtures shared with the end-to-end tests.
#[path = "../../../nemoclaw-e2e/src/image_runtime.rs"]
#[allow(dead_code)]
mod image_runtime;

mod discovery;
mod gateway_readiness;
// Managed gateway resources take only a local engine socket, which only Unix
// clients reach.
#[cfg(unix)]
mod gateway_storage;
mod inference_capabilities;
mod kubernetes_hcl;
mod provider_protocol;
mod runtime_image;
mod service_capacity;
mod service_readiness;
mod service_storage;
// The bundled Docker provider reaches its engine with its own ssh arguments,
// which the relay does not accept.
#[cfg(unix)]
mod vllm_runtime;

pub use nemoclaw_test_fixtures::{openshell, tofu};

/// Failed apply may record new data-source observations and condition
/// results; its managed resources and lineage must still be preserved.
pub fn assert_same_managed_resources(actual: &[u8], expected: &[u8]) {
    fn managed(bytes: &[u8]) -> (String, Vec<serde_json::Value>) {
        let state: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        let resources = state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|resource| resource["mode"] == "managed")
            .cloned()
            .collect();
        (state["lineage"].as_str().unwrap().into(), resources)
    }
    assert_eq!(managed(actual), managed(expected));
}

/// Types still tested only outside this binary, and why.
const ELSEWHERE: [(&str, &str); 0] = [];

/// Every resource and data source the provider serves appears in a contract
/// test, or in [`ELSEWHERE`] with the reason it is not here yet.
#[test]
fn every_type_has_a_contract_test() {
    use tf_provider::Provider;
    let provider = nemoclaw_provider::NemoClawProvider::default();
    let mut diagnostics = tf_provider::Diagnostics::default();
    let types: Vec<String> = provider
        .get_resources(&mut diagnostics)
        .unwrap()
        .into_keys()
        .chain(
            provider
                .get_data_sources(&mut diagnostics)
                .unwrap()
                .into_keys(),
        )
        .collect();
    let sources = [
        include_str!("discovery.rs"),
        include_str!("gateway_readiness.rs"),
        include_str!("gateway_storage.rs"),
        include_str!("inference_capabilities.rs"),
        include_str!("kubernetes_hcl.rs"),
        include_str!("provider_protocol.rs"),
        include_str!("runtime_image.rs"),
        include_str!("service_capacity.rs"),
        include_str!("service_readiness.rs"),
        include_str!("service_storage.rs"),
        include_str!("vllm_runtime.rs"),
    ]
    .concat();
    let missing: Vec<_> = types
        .iter()
        .filter(|kind| {
            !sources.contains(&format!("nemoclaw_{kind}"))
                && !sources.contains(&format!("\"{kind}\""))
                && !ELSEWHERE.iter().any(|(elsewhere, _)| elsewhere == kind)
        })
        .collect();
    for (kind, _) in ELSEWHERE {
        assert!(
            !sources.contains(&format!("nemoclaw_{kind}\"")),
            "{kind} has a contract test; remove it from ELSEWHERE"
        );
    }
    assert!(
        missing.is_empty(),
        "types without a contract test: {missing:?}"
    );
}
