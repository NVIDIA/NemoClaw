// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile,
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

#[test]
fn bearer_auth_compiles_a_managed_credential_reference_without_a_secret() {
    let mut input: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/spark.yaml")).unwrap();
    input["spec"]["inferenceProviders"][0]["service"]["authentication"] = json!("bearer");
    let doc =
        Document::parse(input.to_string().as_bytes()).expect("managed bearer auth must parse");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&input)
    );
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|k| (k.into(), "a".repeat(32)))
    .into();
    let targets = compile::targets(&doc, &generations).unwrap();
    let provider = targets
        .iter()
        .find(|t| t.address == "nemoclaw_provider.inference")
        .unwrap();
    let source: Value = serde_json::from_str(&provider.values["credential_source"]).unwrap();
    assert_eq!(source["kind"], "managedService");
    assert_eq!(source["spec"]["owner"], doc.metadata.uid);
    assert_eq!(source["spec"]["service"]["authentication"], "bearer");
    assert!(provider.values["credential_env"].is_empty());
    assert!(doc.credential_names().is_empty());
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
    input["spec"]["inferenceProviders"][0]["service"]["authentication"] = json!("secret-text");
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
    assert!(
        !jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&input)
    );
}
