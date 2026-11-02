// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Contract tests: Fabric types through pinned OpenTofu against the fake
//! OpenShell gateway, which runs Fabric's configure, prepare, and status
//! commands, and a fake Docker engine for image capabilities.
//!
//! - `hcl/`: scenarios that pass, as native `tests/*.tftest.hcl` files beside
//!   the configuration they apply. This file and `capabilities.rs` start
//!   their fakes and run them.
//! - `failures/`: Rust tests of commands that must fail, which `tofu test`
//!   cannot expect.

// The fake Docker engine listens on a Unix socket.
#[cfg(unix)]
mod capabilities;
mod failures;

use nemoclaw_test_fixtures::{
    Bundle,
    openshell::{self, Fixture},
    tofu::TofuWorkspace,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::Output,
};

const CONTRACT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract");
/// The authored modules whose scenarios run with `tofu test`.
const HCL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract/hcl");

/// The fabric provider Cargo built from this checkout, the one under test.
fn fabric() -> PathBuf {
    nemoclaw_test_fixtures::package_executable!("terraform-provider-fabric")
}

/// A workspace with the fabric provider under test, the bundle's openshell
/// provider, and the fixture provider that observes the fake gateway.
fn workspace() -> TofuWorkspace {
    let bundle = Bundle::from_env();
    TofuWorkspace::with_providers(
        bundle.tofu(),
        &[
            ("openshell", &bundle.provider("openshell")),
            ("fabric", &fabric()),
            (
                "fixture",
                &nemoclaw_test_fixtures::fixture_executable("nemoclaw-fixture-control"),
            ),
        ],
    )
}

/// The harness ref carries the catalog records its agents plan against.
fn catalog_json() -> String {
    serde_json::to_string(
        &nemoclaw_fabric::catalog::FabricCatalog::bundled().for_adapter("nvidia.fabric.pi"),
    )
    .unwrap()
}

/// Every Fabric type is declared by a configuration under `tests/contract`.
#[test]
fn every_fabric_type_has_a_contract_test() {
    let sources = nemoclaw_test_fixtures::tofu::contract_sources(CONTRACT);
    // A block's type and name, such as `resource "fabric_agent" "agent"`.
    let used: BTreeSet<&str> = ["fabric_agent", "fabric_harnesses"]
        .into_iter()
        .filter(|kind| sources.contains(&format!("\"{kind}\" \"")))
        .collect();
    assert_eq!(used.len(), 2, "types with a contract test: {used:?}");
}

/// The Pi agent's lifecycle in `hcl/agent/tests`, the files side by side, each
/// against a new fake gateway.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn pi_agent_lifecycle() {
    let root = workspace();
    root.copy(Path::new(HCL).join("agent"));
    let catalog = catalog_json();
    openshell::test_against_gateways(root, &[("TF_VAR_catalog_json", &catalog)]).await;
}
