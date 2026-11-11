// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Contract tests: each nemoclaw type through pinned OpenTofu against fake
//! Docker engines, gateways, model servers, and Kubernetes APIs.
//!
//! - `hcl/`: scenarios that pass, as native `tests/*.tftest.hcl` files beside
//!   the configuration they apply. This file starts their fakes and runs them.
//! - `failures/`: Rust tests of commands that must fail, which `tofu test`
//!   cannot expect.
//! - The other files hold shared fakes and checks of plans and state that
//!   `tofu test` cannot show.
//!
//! `every_type_has_a_contract_test` requires one for every type the provider
//! serves.

#[path = "../../../test-support/http.rs"]
mod http_fixture;
/// The in-memory Kubernetes API shared with the SDK tests, which reaches its
/// HTTP server as `transport`.
#[path = "../../../test-support/kube_api.rs"]
mod kube_api;
use http_fixture as transport;
/// Fabric catalog fixtures shared with the end-to-end tests.
#[path = "../../../nemoclaw-e2e/src/image_runtime.rs"]
#[expect(
    dead_code,
    reason = "the contract tests use only some of the end-to-end catalog fixtures"
)]
mod image_runtime;

mod failures;
mod fakes;
// The bundled Docker provider reaches its engine with its own ssh arguments,
// which the relay does not accept.
#[cfg(unix)]
mod gpu_requests;
mod provider_protocol;
mod readiness_refs;
mod references;
// The bundled Docker provider reaches its engine with its own ssh arguments,
// which the relay does not accept.
#[cfg(unix)]
mod replacement_cleanup;

pub use nemoclaw_test_fixtures::{openshell, tofu};

pub const CONTRACT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract");
/// The authored modules whose scenarios run with `tofu test`.
pub const HCL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract/hcl");

/// Run each native test file of `module` under `HCL`.
pub fn native<K: AsRef<std::ffi::OsStr>, V: AsRef<std::ffi::OsStr>>(
    module: &str,
    environment: &[(K, V)],
) {
    let root = workspace();
    root.copy(std::path::Path::new(HCL).join(module));
    root.test_all(environment);
}

/// The runtime contracts in `hcl/runtime/tests`, computed without any service.
#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; no live services"]
fn runtime_contracts_carry_their_typed_settings() {
    native::<&str, &str>("runtime", &[]);
}

/// `hcl/host/tests`: passing host checks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated host fixtures"]
async fn host_checks_pass_for_a_healthy_host() {
    let host = fakes::Host::start().await;
    native("host", &host.variables);
}

/// `hcl/storage/tests`: storage keeps the identity it is created with.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn retained_storage_keeps_its_identity() {
    let (engine, volumes) = fakes::volume_engine().await;
    let control = http_fixture::Fixture::start_tcp(move |_| {
        let volumes = volumes.lock().unwrap();
        let observed = serde_json::json!({"volumes": volumes.volumes, "creates": volumes.creates});
        Some((200, observed.to_string().into_bytes()))
    })
    .await;
    native(
        "storage",
        &[
            ("TF_VAR_engine", &engine.endpoint),
            ("NEMOCLAW_FIXTURE_CONTROL", &control.endpoint),
        ],
    );
}

/// A workspace with this package's providers under test (vllm, ollama, and
/// host), and OpenTofu and the openshell and fabric providers from the bundle.
pub fn workspace() -> tofu::TofuWorkspace {
    let bundle = nemoclaw_test_fixtures::Bundle::from_env();
    tofu::TofuWorkspace::with_providers(
        bundle.tofu(),
        &[
            (
                "vllm",
                &nemoclaw_test_fixtures::package_executable!("terraform-provider-vllm"),
            ),
            (
                "ollama",
                &nemoclaw_test_fixtures::package_executable!("terraform-provider-ollama"),
            ),
            (
                "host",
                &nemoclaw_test_fixtures::package_executable!("terraform-provider-host"),
            ),
            ("openshell", &bundle.provider("openshell")),
            ("fabric", &bundle.provider("fabric")),
            (
                "fixture",
                &nemoclaw_test_fixtures::fixture_executable("nemoclaw-fixture-control"),
            ),
        ],
    )
}

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
    fn served(prefix: &str, provider: impl Provider) -> Vec<String> {
        let mut diagnostics = tf_provider::Diagnostics::default();
        provider
            .get_resources(&mut diagnostics)
            .unwrap()
            .into_keys()
            .chain(
                provider
                    .get_data_sources(&mut diagnostics)
                    .unwrap()
                    .into_keys(),
            )
            .map(|name| format!("{prefix}_{name}"))
            .collect()
    }
    // Every type this package's providers serve, by full type name.
    let types: Vec<String> = served("vllm", nemoclaw_provider::ServiceProvider::vllm())
        .into_iter()
        .chain(served(
            "ollama",
            nemoclaw_provider::ServiceProvider::ollama(),
        ))
        .chain(served("host", nemoclaw_provider::HostProvider::default()))
        .collect();
    let sources = tofu::contract_sources(CONTRACT);
    let missing: Vec<_> = types
        .iter()
        .filter(|name| {
            let kind = name.strip_prefix("nemoclaw_").unwrap_or(name);
            !sources.contains(name.as_str())
                && !sources.contains(&format!("\"{kind}\""))
                && !ELSEWHERE.iter().any(|(elsewhere, _)| *elsewhere == kind)
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
