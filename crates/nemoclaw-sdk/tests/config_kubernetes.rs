// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, Runtime, schema};
use serde_json::{Value, json};

fn external_document() -> Value {
    let document =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    let mut input = serde_json::to_value(document).unwrap();
    input["spec"]["sandboxes"][0]["runtime"]["provider"] = json!("kubernetes");
    input
}

#[test]
fn kubernetes_selects_the_gateway_driver_and_preserves_it_on_export() {
    let input = external_document();
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    assert_eq!(
        document.spec.sandboxes[0].runtime.provider.as_str(),
        "kubernetes"
    );
    assert!(jsonschema::is_valid(&schema::input_schema(), &input));
    let exported = document.yaml().unwrap();
    let imported = Document::parse(exported.as_bytes()).unwrap();
    assert_eq!(imported.digest(), document.digest());
    assert_eq!(
        imported.spec.sandboxes[0].runtime.provider.to_string(),
        "kubernetes"
    );
}

#[test]
fn kubernetes_requires_an_explicit_nonempty_image_before_defaults() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for image in [None, Some(json!({})), Some(json!({"ref": ""}))] {
        let mut input = external_document();
        let sandbox = input["spec"]["sandboxes"][0].as_object_mut().unwrap();
        match image {
            Some(image) => {
                sandbox.insert("image".into(), image);
            }
            None => {
                sandbox.remove("image");
            }
        }
        assert!(!validator.is_valid(&input), "{input}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}

#[test]
fn directly_constructed_kubernetes_sandboxes_never_default_their_image() {
    let mut document = Document::parse(external_document().to_string().as_bytes()).unwrap();
    document.spec.sandboxes[0].image = Default::default();
    assert!(document.validate().is_err());
    document.defaults();
    assert!(document.spec.sandboxes[0].image.ref_.is_empty());
    assert!(document.validate().is_err());
}

#[test]
fn kubernetes_image_requirement_preserves_other_sandbox_defaults() {
    let mut input = external_document();
    let mut docker = input["spec"]["sandboxes"][0].clone();
    docker["name"] = json!("docker-assistant");
    docker["runtime"]["provider"] = json!("docker");
    docker.as_object_mut().unwrap().remove("image");
    input["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(docker);
    assert!(jsonschema::is_valid(&schema::input_schema(), &input));
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    assert!(!document.spec.sandboxes[1].image.ref_.is_empty());

    input["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("image");
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
}

#[test]
fn kubernetes_rejects_managed_gateways_before_deployment() {
    let mut input = external_document();
    input["spec"]["gateway"] = json!({"management": "managed"});
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));

    let mut document =
        Document::parse(include_bytes!("fixtures/config/managed-ollama.yaml").as_slice()).unwrap();
    document.spec.sandboxes[0].runtime =
        serde_json::from_value::<Runtime>(json!({"provider": "kubernetes"})).unwrap();
    assert!(document.validate().is_err());
}

#[test]
fn kubernetes_rejects_managed_services_even_when_no_route_selects_them() {
    let mut input = external_document();
    let managed =
        Document::parse(include_bytes!("fixtures/config/managed-ollama.yaml").as_slice()).unwrap();
    input["spec"]["services"] = serde_json::to_value(managed.spec.services.clone()).unwrap();
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));

    let mut document = Document::parse(external_document().to_string().as_bytes()).unwrap();
    document.spec.services = managed.spec.services;
    assert!(document.validate().is_err());
}

#[test]
fn kubernetes_does_not_relax_gateway_transport_or_credential_validation() {
    for endpoint in [
        "http://gateway.example.test:8080",
        "https://user:password@gateway.example.test",
        "https://gateway.example.test?token=secret",
    ] {
        let mut input = external_document();
        input["spec"]["gateway"]["endpoint"] = json!(endpoint);
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}
