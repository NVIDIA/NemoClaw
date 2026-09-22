// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::constraints as c;
use crate::config::{
    constraints,
    schema::validation::{at, forbid, integer, property},
};
use serde_json::{Value, json};

pub(crate) fn constrain(defs: &mut serde_json::Map<String, Value>, normalized: bool) {
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .expect("tagged service variants")
        .iter_mut()
        .find(|variant| variant["properties"]["kind"]["const"] == "vllm")
        .expect("vLLM service variant");
    property(service, "image", json!({"pattern":constraints::IMAGE}));
    service["allOf"] = json!([
        {"oneOf":[{"required":["hardware"]},{"required":["recipe"]}]},
        {"if":{"required":["hardware"]},"then":forbid(&["recipe"])},
        {"if":at("memory/gpuMemoryUtilization",json!({}),true),"then":{"required":["hardware"],"allOf":[at("hardware/minGpuMemoryBytes",json!({}),true),at("hardware/profile",json!({"not":{"enum":super::HardwareProfile::UNIFIED_MEMORY}}),false),forbid(&["recipe"]),at("memory/gpuMemoryGiB",json!({"const":0}),false),at("memory/kvCacheGiB",json!({"const":0}),false)]}},
        {"if":{"required":["recipe"]},"then":{"allOf":[at("serving/modelName",json!({"const":""}),false),at("serving/mambaBackend",json!({"const":""}),false),at("serving",forbid(&["enforceEager"]),false)]}}
    ]);
    service["dependentRequired"] =
        json!({"placement": ["publication"], "publication": ["placement"]});
    service["if"] = json!({"required": ["recipe"]});
    service["then"] = at("memory/gpuMemoryGiB", json!({"const": 0}), false);
    service["else"] = at("serving/speculativeTokens", json!({"const": 0}), false);
    for variant in defs["ServiceHardware"]["anyOf"].as_array_mut().unwrap() {
        if variant["properties"].get("profile").is_none() {
            continue;
        }
        property(variant, "architecture", json!({"enum":["amd64","arm64"]}));
        property(
            variant,
            "minGpuMemoryBytes",
            json!({"minimum":4_u64*(1<<30),"maximum":4_u64*(1<<40)}),
        );
        variant["allOf"] = json!([
            {"if":at("profile", json!({"enum":crate::services::installers::vllm::HardwareProfile::ARM64_SYSTEMS}),true),
             "then":at("architecture",json!({"const":"arm64"}),false),
             "else":{"required":["architecture"]}},
            {"if":at("profile",json!({"enum":super::HardwareProfile::UNIFIED_MEMORY}),true),"then":forbid(&["minGpuMemoryBytes"])}
        ]);
    }
    property(
        &mut defs["Model"],
        "repository",
        json!({"pattern": c::REPOSITORY, "maxLength": 200}),
    );
    property(
        &mut defs["Model"],
        "revision",
        json!({"pattern": c::REVISION}),
    );
    property(
        &mut defs["ServicePlacement"],
        "engine",
        json!({"pattern": "^ssh://"}),
    );
    property(
        &mut defs["ServicePlacement"],
        "networkCidr",
        json!({"pattern": "/24$"}),
    );
    property(
        &mut defs["ServicePublication"],
        "endpoint",
        json!({"pattern": "^http://.+:[0-9]+/v1$"}),
    );
    let serving = &mut defs["Serving"];
    for (field, rule) in [
        ("port", &c::PORT),
        ("contextTokens", &c::CONTEXT_TOKENS),
        ("maxSequences", &c::MAX_SEQUENCES),
        ("batchTokens", &c::BATCH_TOKENS),
        ("startupTimeoutSeconds", &c::STARTUP_TIMEOUT),
    ] {
        integer(serving, field, rule, normalized);
    }
    property(
        serving,
        "speculativeTokens",
        json!({"minimum": 0, "maximum": c::SPECULATIVE_TOKENS_MAX, "default": 0}),
    );
    property(
        serving,
        "toolParser",
        json!({"enum": c::TOOL_PARSERS, "default": ""}),
    );
    property(
        serving,
        "reasoningParser",
        json!({"enum": c::REASONING_PARSERS, "default": ""}),
    );
    let memory = &mut defs["Memory"];
    for (field, rule) in [
        ("hostReserveGiB", &c::HOST_RESERVE),
        ("kvCacheGiB", &c::KV_CACHE),
        ("minAvailableGiB", &c::MIN_AVAILABLE),
        ("minFreeGiB", &c::MIN_FREE),
        ("freeGateGiB", &c::FREE_GATE),
        ("consecutiveSamples", &c::CONSECUTIVE_SAMPLES),
    ] {
        integer(memory, field, rule, normalized);
    }
    property(
        memory,
        "gpuMemoryGiB",
        json!({"minimum": 0, "maximum": c::GPU_MEMORY_MAX,
        "x-nemoclaw-default-rule": format!("Omitted or zero stays zero in the document. Without a recipe or gpuMemoryUtilization, the backend uses {} GiB. A recipe supplies resources.gpuMemoryBytes; gpuMemoryUtilization requires zero here.", c::GPU_MEMORY_DEFAULT)}),
    );
    property(
        &mut defs["Serving"],
        "modelName",
        json!({"anyOf":[{"const":""},{"pattern":constraints::MODEL}],"default":""}),
    );
    property(
        &mut defs["Serving"],
        "mambaBackend",
        json!({"enum":["","flashinfer"],"default":""}),
    );
    property(
        &mut defs["DedicatedHardware"],
        "architecture",
        json!({"const":"amd64"}),
    );
    property(
        &mut defs["DedicatedHardware"],
        "minComputeCapability",
        json!({"minimum":10,"maximum":999}),
    );
    property(
        &mut defs["DedicatedHardware"],
        "minGpuMemoryBytes",
        json!({"minimum":4_u64*(1<<30),"maximum":4_u64*(1<<40)}),
    );
    property(
        &mut defs["DedicatedHardware"],
        "minDriverMajor",
        json!({"minimum":1,"maximum":9999}),
    );
    property(
        &mut defs["ServiceContainer"],
        "sharedMemoryGiB",
        json!({"minimum":1,"maximum":64}),
    );
    property(
        &mut defs["Memory"],
        "gpuMemoryUtilization",
        json!({"minimum":0.05,"maximum":0.95}),
    );
    defs["Memory"]["properties"]["kvCacheGiB"]
        .as_object_mut()
        .unwrap()
        .remove("minimum");
    defs["Memory"]["properties"]["kvCacheGiB"]
        .as_object_mut()
        .unwrap()
        .remove("anyOf");
    defs["Memory"]["properties"]["kvCacheGiB"]["minimum"] = json!(0);
    defs["Memory"]["properties"]["kvCacheGiB"]["x-nemoclaw-default-rule"] = json!(
        "Omitted or zero selects 8 GiB, except gpuMemoryUtilization keeps zero and lets vLLM allocate its cache."
    );
    defs["Memory"]["allOf"] = json!([
        {"if":{"required":["gpuMemoryUtilization"]},"then":{"properties":{"kvCacheGiB":{"const":0},"gpuMemoryGiB":{"const":0}}},"else":{"properties":{"kvCacheGiB":{"anyOf": if normalized { json!([{"minimum":c::KV_CACHE.min,"maximum":c::KV_CACHE.max}]) } else { json!([{"const":0},{"minimum":c::KV_CACHE.min,"maximum":c::KV_CACHE.max}]) }}}}}
    ]);
    recipe(defs);
}

fn recipe(defs: &mut serde_json::Map<String, Value>) {
    use super::recipes::inline::limits as r;
    property(
        &mut defs["InlineRecipe"],
        "apiVersion",
        json!({"const": r::API_VERSION}),
    );
    for field in ["licenses", "sourceNotices"] {
        property(
            &mut defs["InlineRecipe"],
            field,
            json!({"minItems": 1, "items": {"type": "string", "pattern": "^/"}}),
        );
    }
    let compatibility = &mut defs["Compatibility"];
    property(
        compatibility,
        "architecture",
        json!({"enum": r::ARCHITECTURES}),
    );
    property(compatibility, "gpu", json!({"minLength": 1}));
    property(
        compatibility,
        "minDriverMajor",
        json!({"minimum": 1, "maximum": r::DRIVER_MAX}),
    );
    property(
        compatibility,
        "minHostMemoryGiB",
        json!({"minimum": 1, "maximum": r::MEMORY_MAX}),
    );
    property(
        compatibility,
        "imageLabels",
        json!({"required": [r::PROTOCOL_LABEL],
        "properties": {r::PROTOCOL_LABEL: {"const": "v1"}}, "propertyNames": {"pattern": "^org\\.nemoclaw\\."},
        "additionalProperties": {"type": "string", "minLength": 1, "maxLength": r::TOKEN_MAX}}),
    );
    property(
        &mut defs["Tool"],
        "executable",
        json!({"pattern": "^/", "maxLength": r::PATH_MAX}),
    );
    for (name, field) in [
        ("Tool", "sha256"),
        ("Reuse", "preparationKey"),
        ("File", "sha256"),
    ] {
        property(
            defs.get_mut(name).unwrap(),
            field,
            json!({"pattern": r::SHA256}),
        );
    }
    property(
        &mut defs["Reuse"],
        "snapshotDirectory",
        json!({"minLength": 1}),
    );
    let resources = &mut defs["Resources"];
    for (field, min, max) in [
        ("preparedBytes", 1, r::PREPARED_MAX),
        ("preparationMemoryGiB", 1, r::MEMORY_MAX),
        ("gpuMemoryBytes", r::GPU_MIN, r::GPU_MAX),
        ("startupHeadroomGiB", 0, r::MEMORY_MAX),
    ] {
        property(resources, field, json!({"minimum": min, "maximum": max}));
    }
    let settings = &mut defs["Settings"];
    property(
        settings,
        "modelName",
        json!({"pattern": r::TOKEN, "maxLength": r::TOKEN_MAX}),
    );
    for field in [
        "toolParser",
        "reasoningParser",
        "kvCacheDtype",
        "mambaCacheDtype",
    ] {
        property(
            settings,
            field,
            json!({"anyOf": [{"const": ""}, {"pattern": r::TOKEN}], "maxLength": r::TOKEN_MAX, "default": ""}),
        );
    }
    for field in ["lazyLoading", "chunkedPrefill"] {
        property(settings, field, json!({"default": false}));
    }
    for field in ["environment", "preparedEnvironment"] {
        property(
            settings,
            field,
            json!({"propertyNames": {"pattern": "^VLLM_[A-Z0-9_]*$", "not":{"const":"VLLM_API_KEY"}}, "default": {}}),
        );
    }
    property(
        settings,
        "environment",
        json!({"additionalProperties": {"type": "string", "maxLength": r::PATH_MAX, "pattern": "^[^\\u0000]*$"}}),
    );
    let compilation = &mut defs["Compilation"];
    property(
        compilation,
        "mode",
        json!({"maximum": r::COMPILATION_MODE_MAX}),
    );
    property(
        compilation,
        "cudagraphMode",
        json!({"enum": r::CUDAGRAPH_MODES}),
    );
    property(
        compilation,
        "captureSizes",
        json!({"minItems": 1, "maxItems": r::CAPTURE_COUNT_MAX,
        "items": {"type": "integer", "minimum": 1, "maximum": r::CAPTURE_SIZE_MAX}}),
    );
    property(
        &mut defs["Manifest"],
        "repository",
        json!({"pattern": c::REPOSITORY, "maxLength": 200}),
    );
    property(
        &mut defs["Manifest"],
        "revision",
        json!({"pattern": c::REVISION}),
    );
    property(&mut defs["Manifest"], "files", json!({"minItems": 1}));
    property(&mut defs["File"], "name", json!({"minLength": 1}));
    property(&mut defs["File"], "size", json!({"minimum": 1}));
}
