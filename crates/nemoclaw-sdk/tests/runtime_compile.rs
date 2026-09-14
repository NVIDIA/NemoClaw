// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile_runtime, runtime_targets},
    config::Document,
};
use serde_json::json;
#[test]
fn managed_graph_separates_retained_storage_from_replaceable_processes() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .into_iter()
    .map(|k| (k.into(), "b".repeat(32)))
    .collect();
    let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
    let targets = runtime_targets(&document, &generations).unwrap();
    assert_eq!(targets.len(), 4);
    assert_eq!(graph["resource"].as_object().unwrap().len(), 4);
    for kind in ["gateway_storage", "inference_storage"] {
        assert_eq!(
            graph["resource"][format!("nemoclaw_{kind}")]["runtime"]["lifecycle"]["prevent_destroy"],
            true
        );
    }
    assert_eq!(
        graph["resource"]["nemoclaw_managed_gateway"]["runtime"]["depends_on"],
        json!(["nemoclaw_gateway_storage.runtime"])
    );
    assert_eq!(
        graph["resource"]["nemoclaw_inference_service"]["runtime"]["depends_on"],
        json!([
            "nemoclaw_managed_gateway.runtime",
            "nemoclaw_inference_storage.runtime"
        ])
    );
    for target in targets {
        let attrs = &graph["resource"][format!("nemoclaw_{}", target.kind)]["runtime"];
        assert_eq!(attrs["spec"], target.values["spec"]);
        assert!(
            attrs.get("running").is_none(),
            "running is observed, not declared readiness"
        );
    }
    let gateway: serde_json::Value = serde_json::from_str(
        graph["resource"]["nemoclaw_managed_gateway"]["runtime"]["spec"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let storage: serde_json::Value = serde_json::from_str(
        graph["resource"]["nemoclaw_gateway_storage"]["runtime"]["spec"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(gateway["layout"], 2);
    assert!(storage.get("layout").is_none());
}
