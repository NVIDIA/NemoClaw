// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{compile::compile, config::Document};
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::Path};

#[test]
fn reference_graphs_preserve_addresses_dependencies_and_provider_configuration() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let generations: BTreeMap<String, String> = [
        ("workspace", "workspace-generation"),
        ("provider", "provider-generation"),
        ("sandbox", "sandbox-generation"),
        ("ollama", "ollama-generation"),
        ("managed_gateway", "gateway-generation"),
        ("inference_service", "inference-generation"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    for entry in fs::read_dir(root.join("compile")).unwrap() {
        let path = entry.unwrap().path();
        let input = fs::read(root.join("config").join(path.file_stem().unwrap())).unwrap();
        let document = Document::parse(input.as_slice()).unwrap();
        let expected: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(compile(&document, &generations, "0.1.0").unwrap(), expected);
    }
    let document = Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    assert!(compile(&document, &BTreeMap::new(), "0.1.0").is_err());
}
