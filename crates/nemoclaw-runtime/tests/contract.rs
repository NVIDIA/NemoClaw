// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_runtime::RuntimeSpec;
use serde_json::json;

#[test]
fn runtime_accepts_serving_contract_without_deployment_configuration() {
    let mut input = json!({
        "kind": "vllm",
        "hardware": {"profile": "a100", "architecture": "amd64"},
        "model": {"repository": "owner/model", "revision": "a".repeat(40)},
        "serving": {"port": 18888, "contextTokens": 32768, "maxSequences": 1,
            "batchTokens": 1024, "startupTimeoutSeconds": 1800},
        "memory": {"hostReserveGiB": 32, "kvCacheGiB": 8, "minAvailableGiB": 8,
            "minFreeGiB": 3, "freeGateGiB": 12, "consecutiveSamples": 5}
    });
    RuntimeSpec::decode(&input.to_string()).unwrap();
    for field in [
        "image",
        "imagePullPolicy",
        "placement",
        "publication",
        "container",
    ] {
        input[field] = json!({});
        assert!(RuntimeSpec::decode(&input.to_string()).is_err(), "{field}");
        input.as_object_mut().unwrap().remove(field);
    }
    input["serving"]["port"] = 0.into();
    assert!(RuntimeSpec::decode(&input.to_string()).is_err());
}

#[test]
fn runtime_rejects_unsafe_recipe_paths_and_protected_environment_before_work() {
    let original: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/vllm.yaml")).unwrap();
    RuntimeSpec::decode(&original.to_string()).unwrap();
    for (pointer, value) in [
        ("/recipe/preparation/executable", json!("/opt/../bin/sh")),
        ("/recipe/verification/sha256", json!("not-a-digest")),
        ("/recipe/apiVersion", json!("unsupported")),
        ("/recipe/resources/preparedBytes", json!(0)),
        ("/memory/consecutiveSamples", json!(0)),
    ] {
        let mut input = original.clone();
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(
            RuntimeSpec::decode(&input.to_string()).is_err(),
            "{pointer}"
        );
    }
    let mut input = original;
    input["recipe"]["serving"]["environment"] = json!({"VLLM_API_KEY":"must-not-be-exposed"});
    let error = RuntimeSpec::decode(&input.to_string())
        .unwrap_err()
        .to_string();
    assert!(!error.contains("must-not-be-exposed"));
}

#[test]
fn direct_recipe_validation_rejects_structurally_invalid_preparation_limits() {
    let input: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/vllm.yaml")).unwrap();
    let RuntimeSpec::Vllm(mut service) = RuntimeSpec::decode(&input.to_string()).unwrap() else {
        panic!("vLLM fixture")
    };
    service.recipe.as_mut().unwrap().resources.prepared_bytes = 0;
    assert!(service.recipe.as_ref().unwrap().validate(&service).is_err());
}
