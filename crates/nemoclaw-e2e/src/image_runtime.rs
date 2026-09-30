// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{Generations, Target},
    config::Document,
    image_runtime::RuntimeBinding,
};

pub fn binding(adapter_id: &str) -> RuntimeBinding {
    let mut runtime: serde_json::Value =
        serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
    runtime["binaries"] = serde_json::json!({adapter_id:["/usr/local/bin/python3.99"]});
    RuntimeBinding::from_json(
        &serde_json::json!({"runtime":runtime,"adapter_id":adapter_id}).to_string(),
    )
    .unwrap()
}

pub fn policy() -> openshell_core::proto::SandboxPolicy {
    binding("fixture").runtime.policy.to_proto().unwrap()
}

/// Resolve metadata inputs explicitly for protocol tests that bypass OpenTofu discovery.
pub fn targets(
    document: &Document,
    generations: &Generations,
) -> Result<Vec<Target>, nemoclaw_sdk::config::ConfigError> {
    let mut targets = nemoclaw_sdk::compile::targets(document, generations)?;
    for target in &mut targets {
        if target.kind == "provider_profile" {
            target.values.insert(
                "binaries_json".into(),
                serde_json::json!(["/usr/local/bin/python3.99"]).to_string(),
            );
        } else if target.kind == "sandbox" {
            let sandbox = document
                .spec
                .sandboxes
                .iter()
                .find(|sandbox| sandbox.name == target.values["name"])
                .unwrap();
            let requirements = nemoclaw_sdk::fabric_capabilities::FabricRequirements::for_sandbox(
                document, sandbox,
            )?;
            let adapter = requirements.configuration["harness"]["adapter_id"]
                .as_str()
                .unwrap();
            target.values.insert(
                "runtime_json".into(),
                serde_json::to_string(&binding(adapter)).unwrap(),
            );
        }
    }
    Ok(targets)
}

#[cfg(unix)]
use crate::docker as transport;

/// Installed-image evidence for isolated deployment tests; never queries a live engine.
#[cfg(unix)]
pub async fn engine(document: &mut Document) -> transport::Fixture {
    use nemoclaw_sdk::fabric_catalog::{BridgeCapabilities, FabricCatalog, IMAGE_CATALOG_LABEL};
    let mut catalog = FabricCatalog::bundled();
    catalog.bridge = Some(BridgeCapabilities {
        interface_version: 1,
        operations: [
            "validate",
            "prepare",
            "configure",
            "check",
            "invoke",
            "serve",
        ]
        .map(String::from)
        .to_vec(),
        health_checks: vec![],
    });
    let mut runtime = binding("fixture").runtime;
    runtime.binaries = catalog
        .adapters
        .iter()
        .map(|adapter| {
            (
                adapter.adapter_id().into(),
                vec!["/usr/local/bin/python3.99".into()],
            )
        })
        .collect();
    catalog.runtime = Some(runtime);
    let label = serde_json::to_string(&catalog).unwrap();
    let references: Vec<_> = document
        .spec
        .sandboxes
        .iter()
        .map(|sandbox| sandbox.image.ref_.clone())
        .collect();
    let fixture = transport::Fixture::start(move |request| {
        assert_eq!(request.method, "GET");
        assert!(request.body.is_empty());
        let value = if request.path == "/info" {
            serde_json::json!({"ID":"fixture", "Architecture":"arm64", "ServerVersion":"28.0", "OSType":"linux"})
        } else {
            assert!(request.path.starts_with("/images/") && request.path.ends_with("/json"), "{}", request.path);
            serde_json::json!({"Id":"sha256:fixture", "Architecture":"arm64", "Os":"linux", "RepoDigests":references, "Config":{"Labels":{IMAGE_CATALOG_LABEL:label}}})
        };
        Some((200, serde_json::to_vec(&value).unwrap()))
    }).await;
    let nemoclaw_sdk::config::Gateway::External(gateway) = &mut document.spec.gateway else {
        panic!("fixture requires an external gateway")
    };
    gateway.engine = fixture.endpoint.clone();
    fixture
}
