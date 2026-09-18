// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    config::{Document, schema::input_schema},
    hardware::{Capacity, GIB, check_capacity},
};
use serde_json::{Value, json};

fn input() -> Value {
    serde_saphyr::from_str(include_str!("../../../examples/spark/vllm.yaml")).unwrap()
}

#[test]
fn inference_requires_an_explicit_hardware_or_recipe_contract() {
    let mut value = input();
    value["spec"]["inferenceProviders"][0]["service"]
        .as_object_mut()
        .unwrap()
        .remove("hardware");
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
    assert!(
        !jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
}

#[test]
fn explicit_spark_profile_preserves_its_hardware_and_memory_requirements() {
    let mut value = input();
    value["spec"]["inferenceProviders"][0]["service"]["hardware"] = json!({"profile": "dgx-spark"});
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
    let service = doc.spec.inference_providers[0].service.as_ref().unwrap();
    let capacity = Capacity {
        architecture: "arm64".into(),
        gpu: "NVIDIA GB10".into(),
        driver_major: 580,
        total: 121 * GIB,
        available: 100 * GIB,
        free: 90 * GIB,
        disk_free: 200 * GIB,
        ..Default::default()
    };
    check_capacity(service, &capacity, true, 0, 0).unwrap();
    for dimension in ["architecture", "gpu", "driver", "total", "available"] {
        let mut bad = capacity.clone();
        match dimension {
            "architecture" => bad.architecture = "amd64".into(),
            "gpu" => bad.gpu = "another GPU".into(),
            "driver" => bad.driver_major = 579,
            "total" => bad.total = 117 * GIB,
            "available" => bad.available = 39 * GIB,
            _ => unreachable!(),
        }
        assert!(
            check_capacity(service, &bad, true, 0, 0).is_err(),
            "{dimension}"
        );
    }
}

#[test]
fn spark_profile_rejects_unknown_ambiguous_and_dedicated_memory_settings() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for hardware in [
        json!({"profile": "unknown"}),
        json!({"profile": "dgx-spark", "architecture": "amd64"}),
        json!({"profile": "dgx-spark", "unexpected": true}),
    ] {
        let mut value = input();
        value["spec"]["inferenceProviders"][0]["service"]["hardware"] = hardware;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(!schema.is_valid(&value));
    }
    let mut value = input();
    let service = &mut value["spec"]["inferenceProviders"][0]["service"];
    service["hardware"] = json!({"profile": "dgx-spark"});
    service["memory"] = json!({"gpuMemoryUtilization": 0.75});
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
    assert!(!schema.is_valid(&value));

    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/spark/spark-inline.yaml")).unwrap();
    value["spec"]["inferenceProviders"][0]["service"]["hardware"] = json!({"profile": "dgx-spark"});
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
    assert!(!schema.is_valid(&value));
}
