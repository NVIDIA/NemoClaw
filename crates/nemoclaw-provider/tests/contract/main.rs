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
mod kubernetes_hcl;
// Providers launched by OpenTofu reach these fake engines over a Unix socket;
// Windows needs the SSH relay beside them first (#12943).
#[cfg(unix)]
mod runtime_image;
#[cfg(unix)]
mod service_storage;
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
const ELSEWHERE: [(&str, &str); 5] = [
    (
        "gateway_storage",
        "nemoclaw-e2e managed and the live Docker gateway tests, which need Docker (#12879)",
    ),
    (
        "managed_gateway",
        "nemoclaw-e2e provider_protocol, which needs that crate's fixture provider (#12878)",
    ),
    (
        "service_capacity",
        "nemoclaw-e2e service_capacity, which needs that crate's SSH fixture (#12878)",
    ),
    (
        "service_readiness",
        "nemoclaw-e2e service_readiness, which needs that crate's SSH fixture (#12878)",
    ),
    (
        "inference_capabilities",
        "nemoclaw-e2e inference_discovery, only through SDK deployments (#12879)",
    ),
];

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
        include_str!("kubernetes_hcl.rs"),
        include_str!("runtime_image.rs"),
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
