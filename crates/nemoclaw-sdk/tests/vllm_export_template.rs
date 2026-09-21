// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{Generations, runtime_targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

const PROFILE_ID: &str = "vllm.linux-amd64-nvidia.single.nemotron-3.5-lightning-30b-a3b-nvfp4";
const RECIPE_ID: &str = "vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.linux-amd64-single.v1";

fn input() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/nemotron-amd64.yaml")).unwrap();
    let service = &mut value["spec"]["services"]["nemotron"];
    service.as_object_mut().unwrap().remove("placement");
    service.as_object_mut().unwrap().remove("publication");
    service["image"] = Value::Null;
    service["source"] = json!({
        "catalogDigest": format!("sha256:{}", "a".repeat(64)),
        "profile": {
            "id": PROFILE_ID,
            "digest": format!("sha256:{}", "b".repeat(64)),
        },
        "recipe": {
            "id": RECIPE_ID,
            "digest": format!("sha256:{}", "c".repeat(64)),
        },
        "runtimeImage": format!("vllm/vllm-openai@sha256:{}", "d".repeat(64)),
    });
    value["spec"]["gateway"] = json!({"management":"managed", "endpoint":"http://127.0.0.1:17697"});
    value["spec"]["sandboxes"][0]["runtime"]["provider"] = json!("docker");
    value
}

fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

#[test]
fn exported_vllm_template_parses_and_round_trips_the_unresolved_image() {
    let value = input();
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );

    let rendered: Value = serde_saphyr::from_str(&document.yaml().unwrap()).unwrap();
    assert!(rendered["spec"]["services"]["nemotron"]["image"].is_null());
    assert_eq!(
        rendered["spec"]["services"]["nemotron"]["source"],
        value["spec"]["services"]["nemotron"]["source"]
    );
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
}

#[test]
fn unresolved_vllm_image_is_limited_to_the_fixed_export_shape() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut cases = Vec::new();

    let mut missing_image = input();
    missing_image["spec"]["services"]["nemotron"]
        .as_object_mut()
        .unwrap()
        .remove("image");
    cases.push(missing_image);

    let mut placeholder = input();
    placeholder["spec"]["services"]["nemotron"]["image"] = json!("TBD");
    cases.push(placeholder);

    let mut missing_source = input();
    missing_source["spec"]["services"]["nemotron"]
        .as_object_mut()
        .unwrap()
        .remove("source");
    cases.push(missing_source);

    let mut wrong_profile = input();
    wrong_profile["spec"]["services"]["nemotron"]["source"]["profile"]["id"] = json!("vllm.other");
    cases.push(wrong_profile);

    let mut mutable_source_image = input();
    mutable_source_image["spec"]["services"]["nemotron"]["source"]["runtimeImage"] =
        json!("vllm/vllm-openai:latest");
    cases.push(mutable_source_image);

    let mut wrong_model = input();
    wrong_model["spec"]["services"]["nemotron"]["model"]["repository"] =
        json!("nvidia/other-model");
    cases.push(wrong_model);

    let mut wrong_context = input();
    wrong_context["spec"]["services"]["nemotron"]["serving"]["contextTokens"] = json!(32_768);
    cases.push(wrong_context);

    let mut wrong_memory_threshold = input();
    wrong_memory_threshold["spec"]["services"]["nemotron"]["memory"]["hostReserveGiB"] = json!(64);
    cases.push(wrong_memory_threshold);

    let mut missing_authentication = input();
    missing_authentication["spec"]["services"]["nemotron"]
        .as_object_mut()
        .unwrap()
        .remove("authentication");
    cases.push(missing_authentication);

    let mut unrelated_null = input();
    unrelated_null["spec"]["services"]["nemotron"]["model"]["repository"] = Value::Null;
    cases.push(unrelated_null);

    for value in cases {
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(!validator.is_valid(&value));
    }
}

#[test]
fn unresolved_vllm_image_fails_before_runtime_resources_are_planned() {
    let document = Document::parse(input().to_string().as_bytes()).unwrap();
    let error = runtime_targets(&document, &generations()).unwrap_err();
    assert_eq!(
        error.to_string(),
        "vLLM target image is unresolved; replace null with an immutable v1 runtime image reference"
    );
}

#[test]
fn replacing_the_template_image_uses_the_ordinary_runtime_plan() {
    let mut value = input();
    let target_image = format!("registry.example/nemoclaw-vllm@sha256:{}", "e".repeat(64));
    value["spec"]["services"]["nemotron"]["image"] = json!(target_image);
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let targets = runtime_targets(&document, &generations()).unwrap();
    let target = targets
        .iter()
        .find(|target| target.kind == "inference_service")
        .unwrap();
    let spec: Value = serde_json::from_str(&target.values["spec"]).unwrap();
    assert_eq!(spec["process"]["image"], target_image);
}
