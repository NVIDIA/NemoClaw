// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap()
}
fn shared(mut value: Value, sandbox: bool) -> Value {
    let inference = value["spec"]["sandboxes"][0]["agents"][0]
        .as_object_mut()
        .unwrap()
        .remove("inference")
        .unwrap();
    value["spec"]["sandboxes"][0]["agents"][0]["inferenceRef"] = json!("chat");
    let scope = if sandbox {
        &mut value["spec"]["sandboxes"][0]
    } else {
        &mut value["spec"]
    };
    scope["inferences"] = json!({"chat": inference});
    value
}
#[test]
fn inference_reference_preserves_authored_scope_and_runtime_behavior() {
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let original = Document::parse(input().to_string().as_bytes()).unwrap();
    for value in [shared(input(), false), shared(input(), true)] {
        let doc = Document::parse(value.to_string().as_bytes()).expect("shared inference resolves");
        assert!(
            jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&value)
        );
        assert_eq!(
            targets(&doc, &generations).unwrap(),
            targets(&original, &generations).unwrap()
        );
        assert_eq!(
            Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
            doc
        );
        let authored = serde_json::to_value(&doc).unwrap();
        assert!(
            authored["spec"]["sandboxes"][0]["agents"][0]
                .get("inference")
                .is_none()
        );
    }
}
#[test]
fn inference_references_reject_ambiguity_shadowing_and_invisible_providers() {
    let mut missing = shared(input(), false);
    missing["spec"]["sandboxes"][0]["agents"][0]["inferenceRef"] = json!("missing");
    let mut both = shared(input(), false);
    both["spec"]["sandboxes"][0]["agents"][0]["inference"] = json!({});
    let mut shadow = shared(input(), false);
    shadow["spec"]["sandboxes"][0]["inferences"] = shadow["spec"]["inferences"].clone();
    let mut invisible = shared(input(), false);
    invisible["spec"]["sandboxes"][0]["inferenceProviders"] = invisible["spec"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders")
        .unwrap();
    for value in [missing, both, shadow, invisible] {
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "{value}"
        );
    }
}
#[test]
fn unused_inference_is_validated_but_adds_no_credentials_or_resources() {
    let original = input();
    let mut value = original.clone();
    value["spec"]["inferences"] = json!({"unused":{"routes":[{"name":"primary", "provider":{"name":"unused", "provider":"openai", "endpoint":"https://unused.example/v1", "credential":{"env":"UNUSED_KEY"}}, "overrides":{"model":"unused"}}]}});
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    assert!(!doc.credential_names().contains(&"UNUSED_KEY"));
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    assert_eq!(
        targets(&doc, &generations).unwrap(),
        targets(
            &Document::parse(original.to_string().as_bytes()).unwrap(),
            &generations
        )
        .unwrap()
    );
    value["spec"]["inferences"]["unused"]["routes"][0]["provider"]["endpoint"] = json!("bad");
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}

#[test]
fn shared_inline_provider_is_one_instance_and_edits_stay_in_its_definition() {
    let mut value = input();
    let provider = value["spec"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders")
        .unwrap()[0]
        .clone();
    let route = &mut value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0];
    route.as_object_mut().unwrap().remove("providerRef");
    route["provider"] = provider;
    let mut value = shared(value, false);
    let mut other = value["spec"]["sandboxes"][0]["agents"][0].clone();
    other["name"] = json!("other");
    value["spec"]["sandboxes"][0]["agents"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let mut doc = Document::parse(value.to_string().as_bytes()).unwrap();
    doc.inference_provider_mut().unwrap().endpoint = "http://127.0.0.1:19999/v1".into();
    let authored = serde_json::to_value(&doc).unwrap();
    assert_eq!(
        authored["spec"]["inferences"]["chat"]["routes"][0]["provider"]["endpoint"],
        "http://127.0.0.1:19999/v1"
    );
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
}

#[test]
fn shared_pi_metadata_accepts_opaque_nulls_only_inside_the_model() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-pi.yaml")).unwrap();
    value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]["piModel"]
        ["custom"] = Value::Null;
    let mut value = shared(value, false);
    assert!(Document::parse(value.to_string().as_bytes()).is_ok());
    value["spec"]["inferences"]["chat"]["routes"][0]["overrides"]["model"] = Value::Null;
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}
