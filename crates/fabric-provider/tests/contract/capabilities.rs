// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image capabilities in `capabilities/tests`, read from a fake Docker engine.

use super::*;
use nemoclaw_fabric::catalog::{FabricCatalog, IMAGE_CATALOG_LABEL};
use nemoclaw_test_fixtures::http;

/// A Docker engine that serves one image declaring the bundled Fabric
/// catalog, and no image for references containing `missing`.
async fn engine() -> http::Fixture {
    let mut catalog = FabricCatalog::bundled();
    // One adapter, so the image's runtime declares binaries for all of them.
    catalog
        .adapters
        .retain(|adapter| adapter.adapter_id() == "nvidia.fabric.langchain.deepagents");
    let mut runtime: Value =
        serde_json::from_str(include_str!("../../../../image/fabric/runtime.json")).unwrap();
    runtime["binaries"] = json!({"nvidia.fabric.langchain.deepagents": ["/srv/python3.99"]});
    catalog.runtime = Some(serde_json::from_value(runtime).unwrap());
    let label = serde_json::to_string(&catalog).unwrap();
    let digest = format!("registry/agent@sha256:{}", "a".repeat(64));
    http::Fixture::start(move |request| {
        assert_eq!(
            request.method, "GET",
            "capabilities must not change the engine"
        );
        if request.path.contains("missing") {
            return Some((404, br#"{"message":"No such image"}"#.to_vec()));
        }
        let image = json!({"Id": "sha256:config", "Architecture": "arm64", "Os": "linux",
            "RepoDigests": [digest], "Config": {"Labels": {IMAGE_CATALOG_LABEL: label}}});
        Some((200, serde_json::to_vec(&image).unwrap()))
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake Docker engine"]
async fn capabilities_judge_the_image_for_the_configuration() {
    let engine = engine().await;
    let root = TofuWorkspace::with_providers(Bundle::from_env().tofu(), &[("fabric", &fabric())]);
    root.copy(Path::new(CONTRACT).join("capabilities"));
    for file in root.test_files() {
        root.test(&file, &[("TF_VAR_engine", &engine.endpoint)]);
    }
}
