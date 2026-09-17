// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::Document,
};

#[test]
fn native_inference_attaches_provider_without_a_managed_route() {
    let document = Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let resources = targets(&document, &generations).unwrap();
    assert!(resources.iter().all(|r| r.kind != "route"));
    assert!(
        resources
            .iter()
            .any(|r| r.address == "nemoclaw_provider_profile.inference_local")
    );
    let sandbox = &resources
        .iter()
        .find(|r| r.kind == "sandbox")
        .unwrap()
        .values;
    let settings: serde_json::Value = serde_json::from_str(&sandbox["inference_json"]).unwrap();
    assert_eq!(settings["connection"]["model"], "qwen3.5:0.8b");
    assert_eq!(
        settings["connection"]["base_url"],
        "http://172.20.0.1:11436/v1"
    );
    assert_eq!(
        settings["connection"]["api_key_env"],
        "NEMOCLAW_ANONYMOUS_API_KEY"
    );
    assert_eq!(settings["provider"], "local");
}
