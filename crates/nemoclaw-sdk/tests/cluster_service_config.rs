// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, schema};
use nemoclaw_sdk::services::KubernetesService;
use serde_json::{Value, json};

fn cluster_document(kind: &str) -> Value {
    let mut document: Value = serde_saphyr::from_str(include_str!(
        "../../../examples/kubernetes/managed-development.yaml"
    ))
    .unwrap();
    let source = match kind {
        "vllm" => include_str!("../../../examples/spark/vllm.yaml"),
        "ollama" => include_str!("../../../examples/managed-ollama-gpu.yaml"),
        _ => unreachable!(),
    };
    let source: Value = serde_saphyr::from_str(source).unwrap();
    document["spec"]["services"] = source["spec"]["services"].clone();
    document["spec"]["services"]["qwen"]["kubernetes"] = json!({
        "imageMetadata": {"env": "TEST_RUNTIME_IMAGE_METADATA"},
        "cpuRequestMillis": 1000,
        "cpuLimitMillis": 4000,
        "memoryRequestGiB": 32,
        "memoryLimitGiB": 64,
        "storageGiB": 100,
        "storageClass": "model-cache",
        "runtimeClassName": "nvidia",
        "nodeSelector": {"accelerator.example.com/pool": "inference"},
        "tolerations": [{"key": "nvidia.com/gpu", "operator": "Exists", "effect": "NoSchedule"}]
    });
    document
}

#[test]
fn cluster_model_services_accept_explicit_capacity_storage_and_scheduling() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for kind in ["vllm", "ollama"] {
        for driver in ["kubernetes", "openshift"] {
            let mut input = cluster_document(kind);
            input["spec"]["gateway"]["runtime"]["provider"] = json!(driver);
            assert!(validator.is_valid(&input), "{kind} on {driver}");
            let document = Document::parse(input.to_string().as_bytes()).unwrap();
            assert_eq!(
                serde_json::to_value(&document).unwrap()["spec"]["services"]["qwen"]["kubernetes"],
                input["spec"]["services"]["qwen"]["kubernetes"]
            );
            assert_eq!(
                Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
                document
            );
        }
    }
}

#[test]
fn cluster_services_require_image_metadata_before_deployment() {
    for kind in ["vllm", "ollama"] {
        let mut input = cluster_document(kind);
        input["spec"]["services"]["qwen"]["kubernetes"]
            .as_object_mut()
            .unwrap()
            .remove("imageMetadata");
        assert!(
            Document::parse(input.to_string().as_bytes()).is_err(),
            "{kind} lacks runtime image metadata"
        );
    }
}

#[test]
fn cluster_service_metadata_is_included_in_provider_environment_references() {
    for kind in ["vllm", "ollama"] {
        let input = cluster_document(kind);
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        assert!(
            document
                .credential_names()
                .contains(&"TEST_RUNTIME_IMAGE_METADATA"),
            "{kind}"
        );
    }
}

#[test]
fn cluster_storage_reserves_prepared_data_and_working_space() {
    for kind in ["vllm", "ollama"] {
        let mut input = cluster_document(kind);
        input["spec"]["services"]["qwen"]["kubernetes"]["storageGiB"] = json!(15);
        assert!(
            Document::parse(input.to_string().as_bytes()).is_err(),
            "{kind} requires working reserve"
        );
        input["spec"]["services"]["qwen"]["kubernetes"]["storageGiB"] = json!(16);
        Document::parse(input.to_string().as_bytes()).unwrap();
    }
    let mut input = cluster_recipe_document();
    input["spec"]["services"]["qwen"]["recipe"]["resources"]["preparedBytes"] = json!(30_u64 << 30);
    input["spec"]["services"]["qwen"]["kubernetes"]["storageGiB"] = json!(45);
    assert!(
        Document::parse(input.to_string().as_bytes()).is_err(),
        "30 GiB prepared data plus 16 GiB reserve"
    );
    input["spec"]["services"]["qwen"]["kubernetes"]["storageGiB"] = json!(46);
    Document::parse(input.to_string().as_bytes()).unwrap();
}

fn cluster_recipe_document() -> Value {
    let mut input = cluster_document("vllm");
    let settings = input["spec"]["services"]["qwen"]["kubernetes"].clone();
    let recipe: Value =
        serde_saphyr::from_str(include_str!("../../../examples/spark/spark-inline.yaml")).unwrap();
    input["spec"]["services"]["qwen"] = recipe["spec"]["services"]["qwen"].clone();
    input["spec"]["services"]["qwen"]["kubernetes"] = settings;
    input
}

#[test]
fn cluster_memory_limit_covers_shared_memory_and_recipe_preparation() {
    for kind in ["vllm", "ollama"] {
        let mut input = cluster_document(kind);
        input["spec"]["services"]["qwen"]["kubernetes"]["memoryLimitGiB"] = json!(32);
        input["spec"]["services"]["qwen"]["container"] = json!({"sharedMemoryGiB":33});
        assert!(
            Document::parse(input.to_string().as_bytes()).is_err(),
            "{kind} shared memory exceeds the Pod limit"
        );
        input["spec"]["services"]["qwen"]["container"]["sharedMemoryGiB"] = json!(32);
        Document::parse(input.to_string().as_bytes()).unwrap();
    }
    let mut input = cluster_recipe_document();
    input["spec"]["services"]["qwen"]["kubernetes"]["memoryRequestGiB"] = json!(16);
    input["spec"]["services"]["qwen"]["kubernetes"]["memoryLimitGiB"] = json!(19);
    assert!(
        Document::parse(input.to_string().as_bytes()).is_err(),
        "20 GiB recipe preparation must fit the Pod limit"
    );
    input["spec"]["services"]["qwen"]["kubernetes"]["memoryLimitGiB"] = json!(20);
    Document::parse(input.to_string().as_bytes()).unwrap();
}

#[test]
fn cluster_capacity_requests_must_fit_their_limits() {
    for (request, limit) in [
        ("cpuRequestMillis", "cpuLimitMillis"),
        ("memoryRequestGiB", "memoryLimitGiB"),
    ] {
        let mut settings =
            cluster_document("vllm")["spec"]["services"]["qwen"]["kubernetes"].clone();
        settings[request] = json!(5);
        settings[limit] = json!(4);
        let settings: KubernetesService = serde_json::from_value(settings).unwrap();
        assert!(settings.validate().is_err(), "{request} exceeds {limit}");
    }
}

#[test]
fn cluster_scheduling_rejects_invalid_names_labels_and_tolerations() {
    for (field, value) in [
        ("runtimeClassName", json!("Invalid Class")),
        ("storageClass", json!("")),
        ("nodeSelector", json!({"not a label": "gpu"})),
        ("nodeSelector", json!({"pool": "not a value"})),
        (
            "tolerations",
            json!([{"key": "gpu", "operator": "Exists", "value": "true"}]),
        ),
        (
            "tolerations",
            json!([{"operator": "Equal", "value": "gpu"}]),
        ),
        (
            "tolerations",
            json!([{"key": "gpu", "operator": "Exists", "effect": "NoSchedule", "tolerationSeconds": 30}]),
        ),
    ] {
        let mut settings =
            cluster_document("vllm")["spec"]["services"]["qwen"]["kubernetes"].clone();
        settings[field] = value;
        let settings: KubernetesService = serde_json::from_value(settings).unwrap();
        assert!(settings.validate().is_err(), "accepted invalid {field}");
    }
}

#[test]
fn cluster_tolerations_reject_null_effect_and_noninteger_seconds() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for (field, value) in [
        ("effect", Value::Null),
        ("tolerationSeconds", Value::Null),
        ("tolerationSeconds", json!("30")),
        ("tolerationSeconds", json!(-1)),
        ("tolerationSeconds", json!(1.5)),
    ] {
        let mut input = cluster_document("vllm");
        let mut toleration = json!({"key":"gpu", "operator":"Exists", "effect":"NoExecute"});
        toleration[field] = value;
        input["spec"]["services"]["qwen"]["kubernetes"]["tolerations"] = json!([toleration]);
        assert!(!validator.is_valid(&input), "invalid {field}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}

#[test]
fn cluster_resources_must_fit_kubernetes_integer_quantities() {
    for field in ["memoryRequestGiB", "memoryLimitGiB", "storageGiB"] {
        let mut settings =
            cluster_document("vllm")["spec"]["services"]["qwen"]["kubernetes"].clone();
        settings[field] = json!(u64::MAX);
        if field == "memoryRequestGiB" {
            settings["memoryLimitGiB"] = json!(u64::MAX);
        }
        let settings: KubernetesService = serde_json::from_value(settings).unwrap();
        assert!(settings.validate().is_err(), "unrepresentable {field}");
    }
}

#[test]
fn cluster_services_reject_missing_capacity_and_incompatible_execution_settings() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for kind in ["vllm", "ollama"] {
        for field in [
            "cpuRequestMillis",
            "cpuLimitMillis",
            "memoryRequestGiB",
            "memoryLimitGiB",
            "storageGiB",
        ] {
            let mut input = cluster_document(kind);
            input["spec"]["services"]["qwen"]["kubernetes"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(!validator.is_valid(&input), "missing {field}");
            assert!(Document::parse(input.to_string().as_bytes()).is_err());
        }
        for variation in ["implicit", "docker", "external", "host-ipc", "ssh"] {
            let mut input = cluster_document(kind);
            match variation {
                "implicit" => {
                    input["spec"]["services"]["qwen"]
                        .as_object_mut()
                        .unwrap()
                        .remove("kubernetes");
                }
                "docker" => {
                    input["spec"]["gateway"] =
                        json!({"management":"managed", "runtime":{"provider":"docker"}});
                    for sandbox in input["spec"]["sandboxes"].as_array_mut().unwrap() {
                        sandbox["image"].as_object_mut().unwrap().remove("metadata");
                    }
                }
                "external" => {
                    input["spec"]["gateway"] = json!({"management":"external", "runtime":{"provider":"kubernetes"}, "endpoint":"https://gateway.example"});
                }
                "host-ipc" => {
                    input["spec"]["services"]["qwen"]["container"] = json!({"ipc":"host"});
                }
                "ssh" => {
                    input["spec"]["services"]["qwen"]["placement"] =
                        json!({"engine":"ssh://gpu@10.0.0.5", "networkCidr":"10.30.0.0/24"});
                    input["spec"]["services"]["qwen"]["publication"] =
                        json!({"endpoint":"http://10.0.0.5:8000/v1", "bindAddress":"10.0.0.5"});
                }
                _ => unreachable!(),
            }
            assert!(!validator.is_valid(&input), "{kind}: {variation}");
            assert!(
                Document::parse(input.to_string().as_bytes()).is_err(),
                "{kind}: {variation}"
            );
        }
    }
}

#[test]
fn docker_service_defaults_do_not_add_cluster_settings() {
    for source in [
        include_str!("../../../examples/spark/vllm.yaml"),
        include_str!("../../../examples/managed-ollama-gpu.yaml"),
    ] {
        let document = Document::parse(source.as_bytes()).unwrap();
        let value = serde_json::to_value(&document).unwrap();
        assert!(
            value["spec"]["services"]["qwen"]
                .get("kubernetes")
                .is_none()
        );
        assert_eq!(
            Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
            document
        );
    }
}
