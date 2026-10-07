// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{compile, config::Document};
use serde_json::{Value, json};

fn document(kind: &str) -> Document {
    let source = match kind {
        "vllm" => include_str!("../../../examples/spark/vllm.yaml"),
        "ollama" => include_str!("../../../examples/managed-ollama-gpu.yaml"),
        _ => unreachable!(),
    };
    let mut input: Value = serde_saphyr::from_str(source).unwrap();
    input["spec"]["gateway"] = json!({
        "management": "managed", "endpoint": "https://127.0.0.1:17671",
        "runtime": {"provider": "kubernetes"},
        "kubernetes": {"kubeconfig": {"env": "TEST_KUBECONFIG"},
            "context": "cluster", "namespace": "test-models",
            "authentication": {"profile": "development"}}
    });
    input["spec"]["services"]["qwen"]["kubernetes"] = json!({
        "imageMetadata": {"env": "TEST_RUNTIME_METADATA"},
        "cpuRequestMillis": 1000, "cpuLimitMillis": 4000,
        "memoryRequestGiB": 32, "memoryLimitGiB": 64, "storageGiB": 100
    });
    if kind == "vllm" {
        input["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
    }
    input["spec"]["sandboxes"][0]["image"] = json!({
        "ref": format!("fixture-agent@sha256:{}", "a".repeat(64)),
        "metadata": {"env": "TEST_IMAGE_METADATA"}
    });
    Document::parse(input.to_string().as_bytes()).unwrap()
}

fn generations() -> compile::Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_storage",
        "kubernetes_gateway",
        "inference_service",
        "ollama_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

#[test]
fn cluster_services_provision_before_agents_and_publish_their_cluster_endpoint() {
    for kind in ["vllm", "ollama"] {
        let document = document(kind);
        let graph = compile::compile_runtime(&document, &generations(), "0.1.0").unwrap();
        let resource = &graph["resource"]["nemoclaw_kubernetes_service"]["qwen"];
        let spec: Value =
            serde_json::from_str(resource["spec"].as_str().expect("cluster service resource"))
                .unwrap();
        assert_eq!(spec["runtime"]["kind"], kind);
        assert_eq!(
            resource["depends_on"],
            json!([
                "nemoclaw_kubernetes_service_storage.qwen",
                "nemoclaw_kubernetes_gateway.runtime"
            ])
        );
        assert_eq!(
            graph["resource"]["nemoclaw_kubernetes_service_storage"]["qwen"]["lifecycle"]["prevent_destroy"],
            true
        );
        assert!(
            graph["terraform"]["required_providers"]
                .get("docker")
                .is_none()
        );
        compile::compile(&document, &generations(), "0.1.0").unwrap();
        let targets = compile::targets(&document, &generations()).unwrap();
        let provider = targets
            .iter()
            .find(|target| target.kind == "provider")
            .unwrap();
        let profile = targets
            .iter()
            .find(|target| target.kind == "provider_profile")
            .unwrap();
        let storage: Value = serde_json::from_str(
            profile
                .values
                .get("cluster_source")
                .expect("owned cluster endpoint provenance"),
        )
        .unwrap();
        assert_eq!(storage["name"], spec["name"]);
        assert_eq!(storage["owner"], document.metadata.uid);
        assert_eq!(storage["authenticated"], kind == "vllm");
        if kind == "vllm" {
            let credential: Value =
                serde_json::from_str(&provider.values["credential_source"]).unwrap();
            assert_eq!(credential["storage"], storage);
        }
        let port = spec["runtime"]["serving"]["port"].as_i64().unwrap();
        assert_eq!(
            provider.values["endpoint"],
            format!(
                "http://{}.test-models.svc.cluster.local:{port}/v1",
                spec["name"].as_str().unwrap()
            )
        );
    }
}

#[test]
fn cluster_endpoint_provenance_preserves_literal_kubeconfig_contexts() {
    let mut input = serde_json::to_value(document("ollama")).unwrap();
    input["spec"]["gateway"]["kubernetes"]["context"] = json!("cluster-${literal}-%{literal}");
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    let graph = compile::compile(&document, &generations(), "0.1.0").unwrap();
    let profiles = graph["resource"]["nemoclaw_provider_profile"]
        .as_object()
        .unwrap();
    let source = profiles.values().next().unwrap()["cluster_source"]
        .as_str()
        .unwrap();
    assert!(source.contains("cluster-$${literal}-%%{literal}"));
}

#[test]
fn runtime_updates_preserve_model_storage_and_teardown_keeps_only_established_claims() {
    for kind in ["vllm", "ollama"] {
        let document = document(kind);
        let graph = compile::compile_runtime(&document, &generations(), "0.1.0").unwrap();
        let mut changed = serde_json::to_value(&document).unwrap();
        changed["spec"]["services"]["qwen"]["image"] =
            json!(format!("fixture-runtime@sha256:{}", "b".repeat(64)));
        changed["spec"]["services"]["qwen"]["kubernetes"]["cpuLimitMillis"] = json!(8000);
        let changed = Document::parse(changed.to_string().as_bytes()).unwrap();
        let updated = compile::compile_runtime(&changed, &generations(), "0.1.0").unwrap();
        assert_eq!(
            graph["resource"]["nemoclaw_kubernetes_service_storage"],
            updated["resource"]["nemoclaw_kubernetes_service_storage"]
        );
        assert_ne!(
            graph["resource"]["nemoclaw_kubernetes_service"],
            updated["resource"]["nemoclaw_kubernetes_service"]
        );
        let all = compile::runtime_targets(&document, &generations())
            .unwrap()
            .into_iter()
            .map(|target| target.address)
            .collect();
        let teardown =
            compile::compile_teardown(&document, &generations(), "0.1.0", &all, true).unwrap();
        assert_eq!(
            teardown.retained,
            [
                "nemoclaw_kubernetes_service_storage.qwen".into(),
                "nemoclaw_kubernetes_storage.runtime".into()
            ]
            .into()
        );
        assert!(
            teardown.graph["resource"]
                .get("nemoclaw_kubernetes_service")
                .is_none()
        );
        let partial = compile::compile_teardown(
            &document,
            &generations(),
            "0.1.0",
            &["nemoclaw_kubernetes_storage.runtime".into()].into(),
            true,
        )
        .unwrap();
        assert!(
            partial.graph["resource"]
                .get("nemoclaw_kubernetes_service_storage")
                .is_none()
        );
        let exported = serde_json::to_vec(&document).unwrap();
        assert_eq!(Document::parse(exported.as_slice()).unwrap(), document);
    }
}
