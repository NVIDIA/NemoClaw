// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile_runtime, runtime_targets},
    config::Document,
};
use serde_json::json;

#[test]
fn multiple_services_share_image_acquisition_without_custom_capacity_gates() {
    let document =
        Document::parse(include_bytes!("../../../examples/spark/two-models.yaml").as_slice())
            .unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "b".repeat(32)))
    .into();
    let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert!(graph["data"].get("nemoclaw_service_capacity").is_none());
    let readiness = &graph["data"]["nemoclaw_gateway_capabilities"]["current"];
    assert_eq!(readiness["wait_timeout_seconds"], 90);
    assert_eq!(readiness["required_compute_drivers"], json!(["docker"]));
    assert_eq!(
        readiness["depends_on"],
        json!(["docker_container.managed_gateway_runtime"])
    );
    assert_eq!(
        readiness["lifecycle"]["postcondition"][0]["condition"],
        "${self.compatible}"
    );
    let containers = graph["resource"]["docker_container"].as_object().unwrap();
    assert_eq!(containers.len(), 3);
    assert_eq!(
        graph["resource"]["docker_image"].as_object().unwrap().len(),
        2
    );
    for (name, attrs) in containers {
        if name == "managed_gateway_runtime" {
            continue;
        }
        assert!(attrs.get("lifecycle").is_none());
        assert_eq!(attrs["gpus"], "all");
        assert!(attrs["memory"].as_i64().unwrap() > 0);
        assert_eq!(attrs["memory"], attrs["memory_swap"]);
    }
}
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
    assert_eq!(targets.len(), 6);
    assert_eq!(graph["resource"].as_object().unwrap().len(), 4);
    for (kind, name) in [
        ("nemoclaw_gateway_storage", "runtime"),
        ("docker_volume", "inference_storage_inference_qwen"),
    ] {
        assert_eq!(
            graph["resource"][kind][name]["lifecycle"]["prevent_destroy"],
            true
        );
    }
    assert_eq!(
        graph["resource"]["docker_container"]["managed_gateway_runtime"]["depends_on"],
        json!(["nemoclaw_gateway_storage.runtime"])
    );
    let gateway = &graph["resource"]["docker_container"]["managed_gateway_runtime"];
    let gateway_spec: nemoclaw_sdk::managed::Spec = serde_json::from_str(
        graph["resource"]["nemoclaw_gateway_storage"]["runtime"]["spec"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let command = gateway["command"].as_array().unwrap();
    let gateway_port = command.windows(2).find(|pair| pair[0] == "--port").unwrap()[1]
        .as_str()
        .unwrap()
        .parse::<u16>()
        .unwrap();
    assert!(gateway.get("network_mode").is_none());
    assert_eq!(
        gateway["networks_advanced"],
        json!([{
            "name": gateway_spec.network(),
            "ipv4_address": gateway_spec.gateway_address().unwrap()
        }])
    );
    assert_eq!(
        gateway["ports"],
        json!([{
            "internal": gateway_port,
            "external": gateway_port,
            "ip": "127.0.0.1",
            "protocol": "tcp"
        }])
    );
    assert_eq!(
        graph["resource"]["docker_container"]["inference_service_inference_qwen"]["depends_on"],
        json!([
            "docker_container.managed_gateway_runtime",
            "docker_volume.inference_storage_inference_qwen"
        ])
    );
    for target in targets
        .into_iter()
        .filter(|target| target.address.starts_with("nemoclaw_"))
    {
        let attrs = &graph["resource"][format!("nemoclaw_{}", target.kind)]
            [target.address.split_once('.').unwrap().1];
        assert_eq!(attrs["spec"], target.values["spec"]);
        assert!(
            attrs.get("running").is_none(),
            "running is observed, not declared readiness"
        );
    }
    let storage: serde_json::Value = serde_json::from_str(
        graph["resource"]["nemoclaw_gateway_storage"]["runtime"]["spec"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(storage["layout"], 1);
}

#[test]
fn remote_service_is_independent_of_the_external_sandbox_gateway() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let mut value = serde_json::to_value(document).unwrap();
    value["spec"]["gateway"] = json!({"management":"external","endpoint":"http://127.0.0.1:17670"});
    value["spec"]["sandboxes"][0]["runtime"]["provider"] = json!("podman");
    value["spec"]["services"]["qwen"]["placement"] =
        json!({"engine":"ssh://operator@gpu-box","networkCidr":"172.30.119.0/24"});
    value["spec"]["services"]["qwen"]["publication"] =
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
    assert_eq!(runtime_targets(&document, &generations).unwrap().len(), 4);
    assert!(graph["resource"].get("nemoclaw_managed_gateway").is_none());
    assert_eq!(
        graph["resource"]["docker_container"]["inference_service_inference_qwen"]["depends_on"],
        json!([
            "docker_volume.inference_storage_inference_qwen",
            format!(
                "docker_network.{}",
                graph["resource"]["docker_network"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .next()
                    .unwrap()
            )
        ])
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
        invalid["spec"]["services"]["qwen"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(Document::parse(serde_json::to_vec(&invalid).unwrap().as_slice()).is_err());
    }
    for cidr in ["172.30.119.8/24", "10.0.0.0/24"] {
        let mut invalid = value.clone();
        invalid["spec"]["services"]["qwen"]["placement"]["networkCidr"] = json!(cidr);
        assert!(Document::parse(serde_json::to_vec(&invalid).unwrap().as_slice()).is_err());
    }
    let mut invalid = value.clone();
    invalid["spec"]["services"]["qwen"]["publication"]["bindAddress"] = json!("0.0.0.0");
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

#[test]
fn docker_provider_owns_disposable_compute_and_image_acquisition() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "b".repeat(32)))
    .into();
    let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert!(
        graph["resource"]
            .get("nemoclaw_inference_service")
            .is_none()
    );
    let container = &graph["resource"]["docker_container"]["inference_service_inference_qwen"];
    assert_eq!(container["gpus"], "all");
    assert!(
        container["image"]
            .as_str()
            .unwrap()
            .starts_with("${docker_image.")
    );
    assert!(graph["data"].get("nemoclaw_service_capacity").is_none());
    assert!(container.get("lifecycle").is_none());
    let targets = runtime_targets(&document, &generations).unwrap();
    assert!(targets.iter().any(|target| target.address
        == "docker_container.inference_service_inference_qwen"
        && target.kind == "inference_service"));
    assert!(targets.iter().any(|target| target.kind == "docker_image"));
}
