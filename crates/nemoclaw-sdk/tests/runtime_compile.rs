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
            graph["resource"][format!("nemoclaw_{kind}")][if kind == "gateway_storage" {
                "runtime"
            } else {
                "inference_qwen"
            }]["lifecycle"]["prevent_destroy"],
            true
        );
    }
    assert_eq!(
        graph["resource"]["nemoclaw_managed_gateway"]["runtime"]["depends_on"],
        json!(["nemoclaw_gateway_storage.runtime"])
    );
    assert_eq!(
        graph["resource"]["nemoclaw_inference_service"]["inference_qwen"]["depends_on"],
        json!([
            "nemoclaw_managed_gateway.runtime",
            "nemoclaw_inference_storage.inference_qwen"
        ])
    );
    for target in targets {
        let attrs = &graph["resource"][format!("nemoclaw_{}", target.kind)]
            [target.address.split_once('.').unwrap().1];
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

#[test]
fn remote_service_is_independent_of_the_external_sandbox_gateway() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let mut value = serde_json::to_value(document).unwrap();
    value["spec"]["gateway"] = json!({"management":"external","endpoint":"http://127.0.0.1:17670"});
    value["spec"]["sandboxes"][0]["runtime"]["provider"] = json!("podman");
    value["spec"]["inferenceProviders"][0]["service"]["placement"] =
        json!({"engine":"ssh://operator@gpu-box","networkCidr":"172.30.119.0/24"});
    value["spec"]["inferenceProviders"][0]["service"]["publication"] =
        json!({"endpoint":"http://10.0.0.8:18888/v1","bindAddress":"10.0.0.8"});
    let bytes = serde_json::to_vec(&value).unwrap();
    let document = Document::parse(bytes.as_slice()).unwrap();
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
    assert_eq!(runtime_targets(&document, &generations).unwrap().len(), 2);
    assert!(graph["resource"].get("nemoclaw_managed_gateway").is_none());
    assert_eq!(
        graph["resource"]["nemoclaw_inference_service"]["inference_qwen"]["depends_on"],
        json!(["nemoclaw_inference_storage.inference_qwen"])
    );
    assert_eq!(
        document.inference_endpoint().unwrap(),
        "http://10.0.0.8:18888/v1"
    );
    let mut changed_gateway = document.clone();
    changed_gateway.spec.gateway.endpoint = "http://127.0.0.1:17999".into();
    let original_targets = runtime_targets(&document, &generations).unwrap();
    let changed_targets = runtime_targets(&changed_gateway, &generations).unwrap();
    for (original, changed) in original_targets.iter().zip(changed_targets.iter()) {
        assert_eq!(
            original.values, changed.values,
            "gateway connection leaked into remote model identity"
        );
    }

    let targets = runtime_targets(&document, &generations).unwrap();
    let spec: nemoclaw_sdk::managed::Spec =
        serde_json::from_str(&targets[1].values["spec"]).unwrap();
    assert_eq!(spec.engine(), "ssh://operator@gpu-box");
    let launch = serde_json::to_value(spec.container("/data").unwrap()).unwrap();
    assert!(!launch["Env"][0].as_str().unwrap().contains("ssh://"));
    assert_eq!(
        launch["HostConfig"]["PortBindings"]["18888/tcp"][0]["HostIp"],
        "10.0.0.8"
    );
    for field in ["placement", "publication"] {
        let mut invalid = value.clone();
        invalid["spec"]["inferenceProviders"][0]["service"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(Document::parse(serde_json::to_vec(&invalid).unwrap().as_slice()).is_err());
    }
    for cidr in ["172.30.119.8/24", "10.0.0.0/24"] {
        let mut invalid = value.clone();
        invalid["spec"]["inferenceProviders"][0]["service"]["placement"]["networkCidr"] =
            json!(cidr);
        assert!(Document::parse(serde_json::to_vec(&invalid).unwrap().as_slice()).is_err());
    }
    let mut invalid = value.clone();
    invalid["spec"]["inferenceProviders"][0]["service"]["publication"]["bindAddress"] =
        json!("0.0.0.0");
    assert!(Document::parse(serde_json::to_vec(&invalid).unwrap().as_slice()).is_err());
}

#[test]
fn remote_example_parses_with_pinned_model_and_runtime() {
    let document =
        Document::parse(include_bytes!("../../../examples/spark/remote-vllm.yaml").as_slice())
            .unwrap();
    assert_eq!(document.spec.sandboxes[0].runtime.provider, "podman");
    assert_eq!(
        document.inference_endpoint().unwrap(),
        "http://10.0.0.8:18898/v1"
    );
}
