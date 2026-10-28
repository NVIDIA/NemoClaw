// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_runtime::{
    Error, RuntimeSpec,
    snapshot::{File, VerifiedFile},
    vllm::recipes::{
        huggingface,
        preparation::{self, OutputManifest},
    },
};
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
fn runtime_rejects_recipes_that_enable_vllm_development_routes() {
    let original: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/vllm.yaml")).unwrap();
    for (field, value) in [("environment", "1"), ("preparedEnvironment", ".")] {
        let mut input = original.clone();
        input["recipe"]["serving"][field] = json!({ "VLLM_SERVER_DEV_MODE": value });
        assert!(RuntimeSpec::decode(&input.to_string()).is_err(), "{field}");
    }
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

#[test]
fn a_model_snapshot_must_match_the_recipe_snapshot() {
    let input: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/vllm.yaml")).unwrap();
    let RuntimeSpec::Vllm(service) = RuntimeSpec::decode(&input.to_string()).unwrap() else {
        panic!("vLLM fixture")
    };
    let mut snapshot = service.recipe.as_ref().unwrap().snapshot.clone().unwrap();
    huggingface::validate_manifest(&service, &snapshot).unwrap();
    snapshot.files[0].sha256 = "0".repeat(64);
    assert!(matches!(
        huggingface::validate_manifest(&service, &snapshot),
        Err(Error::Conflict(
            "snapshot manifest conflicts with recipe snapshot"
        ))
    ));
}

#[test]
fn a_prepared_output_manifest_must_name_the_recipe_key_and_distinct_files() {
    let input: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/vllm.yaml")).unwrap();
    let RuntimeSpec::Vllm(service) = RuntimeSpec::decode(&input.to_string()).unwrap() else {
        panic!("vLLM fixture")
    };
    let recipe = service.recipe.as_ref().unwrap();
    let key = recipe.key(&service);
    let file = |name: &str| VerifiedFile {
        file: File {
            name: name.into(),
            size: 100,
            sha256: "a".repeat(64),
        },
        modified: 1,
    };
    let output = OutputManifest {
        key: key.clone(),
        files: vec![file("prepared.bin"), file("prepared.json")],
    };
    preparation::validate_manifest(recipe, &key, &output).unwrap();
    for changed in [
        OutputManifest {
            key: "wrong".into(),
            ..output.clone()
        },
        OutputManifest {
            files: vec![file("prepared.bin"), file("prepared.bin")],
            ..output
        },
    ] {
        assert!(preparation::validate_manifest(recipe, &key, &changed).is_err());
    }
}

#[test]
fn runtime_errors_identify_declared_fields_without_echoing_values_or_map_keys() {
    let original: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/vllm.yaml")).unwrap();
    for (pointer, value, field) in [
        ("/serving/port", json!("PRIVATE_SENTINEL"), "port"),
        ("/serving/port", json!(0), "port"),
        (
            "/recipe/apiVersion",
            json!("PRIVATE_SENTINEL"),
            "apiVersion",
        ),
        ("/memory/consecutiveSamples", json!(0), "consecutiveSamples"),
    ] {
        let mut input = original.clone();
        *input.pointer_mut(pointer).unwrap() = value;
        let error = RuntimeSpec::decode(&input.to_string())
            .unwrap_err()
            .to_string();
        assert!(error.contains(field), "{error}");
        assert!(error.contains("v1"), "{error}");
        assert!(!error.contains("PRIVATE_SENTINEL"), "{error}");
    }
    for pointer in ["", "/serving", "/recipe/serving/environment"] {
        let mut input = original.clone();
        if pointer.ends_with("/environment") {
            input["recipe"]["serving"]["environment"] = json!({});
        }
        input.pointer_mut(pointer).unwrap()["PRIVATE_SENTINEL"] = json!("PRIVATE_SENTINEL");
        let error = RuntimeSpec::decode(&input.to_string())
            .unwrap_err()
            .to_string();
        assert!(error.contains("runtime specification"), "{error}");
        assert!(!error.contains("PRIVATE_SENTINEL"), "{error}");
    }
}
