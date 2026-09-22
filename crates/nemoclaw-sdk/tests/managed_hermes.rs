// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::Document;
use serde_json::Value;

#[test]
fn hermes_accepts_managed_gateway_and_inference() {
    for source in [
        include_str!("../../../examples/local.yaml"),
        include_str!("../../../examples/managed-ollama.yaml"),
    ] {
        let mut value: Value = serde_saphyr::from_str(source).unwrap();
        value["spec"]["sandboxes"][0]["harness"]["kind"] = "hermes".into();
        let document = Document::parse(serde_json::to_vec(&value).unwrap().as_slice())
            .expect("Hermes native server supports managed services");
        assert_eq!(
            Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
            document
        );
    }
}
