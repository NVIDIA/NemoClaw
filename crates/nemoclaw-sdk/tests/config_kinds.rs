// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{ExternalTarget, Harness, InferenceProvider, ManagedTarget};
use serde_json::json;

#[test]
fn closed_selectors_reject_unknown_values_and_harnesses_reject_malformed_identifiers() {
    assert!(serde_json::from_value::<Harness>(json!({"kind":" \t"})).is_err());
    assert!(serde_json::from_value::<ManagedTarget>(json!({"unknown": {}})).is_err());
    assert!(serde_json::from_value::<ExternalTarget>(json!({"unknown": {}})).is_err());
    assert!(serde_json::from_value::<InferenceProvider>(json!({"provider":"unknown"})).is_err());
}

#[test]
fn required_selectors_are_not_silently_defaulted() {
    assert!(serde_json::from_value::<Harness>(json!({})).is_err());
    assert!(
        serde_json::from_value::<InferenceProvider>(json!({"endpoint":"https://example.com/v1"}))
            .is_err()
    );
}

#[test]
fn selector_names_round_trip_without_changing_wire_values() {
    use nemoclaw_sdk::config::{ComputeDriver, HarnessKind, InferenceProviderKind};
    fn round_trip<T>(cases: &[(T, &str)])
    where
        T: std::fmt::Debug
            + PartialEq
            + std::fmt::Display
            + std::str::FromStr
            + serde::Serialize
            + serde::de::DeserializeOwned,
        T::Err: std::fmt::Debug,
    {
        for (kind, name) in cases {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(name));
            assert_eq!(&serde_json::from_value::<T>(json!(name)).unwrap(), kind);
            assert_eq!(&name.parse::<T>().unwrap(), kind);
            assert_eq!(kind.to_string(), *name);
        }
        for name in ["", " "] {
            assert!(name.parse::<T>().is_err());
            assert!(serde_json::from_value::<T>(json!(name)).is_err());
        }
    }
    for name in [
        "nvidia.fabric.pi",
        "org.fabric.fixture.discoverable",
        "../opaque-id",
    ] {
        round_trip(&[(name.parse::<HarnessKind>().unwrap(), name)]);
    }
    round_trip(&[
        (ComputeDriver::Docker, "docker"),
        (ComputeDriver::Podman, "podman"),
        (ComputeDriver::Kubernetes, "kubernetes"),
        (ComputeDriver::OpenShift, "openshift"),
    ]);
    round_trip(&[
        (InferenceProviderKind::Openai, "openai"),
        (InferenceProviderKind::Anthropic, "anthropic"),
    ]);
}

#[test]
fn an_omitted_target_selects_docker_without_changing_intent_digest() {
    use nemoclaw_sdk::config::{ComputeDriver, Document};
    let document =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    for target in [None, Some(json!({"docker": {}}))] {
        let mut input = serde_json::to_value(&document).unwrap();
        let gateway = input["spec"]["gateway"].as_object_mut().unwrap();
        match target {
            Some(target) => gateway.insert("target".into(), target),
            None => gateway.remove("target"),
        };
        let parsed = Document::parse(input.to_string().as_bytes()).unwrap();
        assert_eq!(parsed.spec.gateway.compute_driver(), ComputeDriver::Docker);
        assert_eq!(parsed.digest(), document.digest());
        assert_eq!(parsed.yaml().unwrap(), document.yaml().unwrap());
    }
}

#[test]
fn the_target_is_chosen_once_on_the_gateway() {
    use nemoclaw_sdk::config::{ComputeDriver, Document, schema::input_schema};
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let base: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
    // Both gateway kinds carry the target.
    for management in ["managed", "external"] {
        let mut input = base.clone();
        input["spec"]["gateway"] = if management == "external" {
            json!({"management": "external", "endpoint": "https://gateway.example:8080", "target": {"podman": {}}})
        } else {
            json!({"management": "managed", "target": {"podman": {"engine": "unix:///run/user/1000/podman/podman.sock"}}})
        };
        assert!(validator.is_valid(&input), "{management}");
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        assert_eq!(
            document.spec.gateway.compute_driver(),
            ComputeDriver::Podman,
            "{management}"
        );
    }
    // A sandbox selects no runtime of its own.
    let mut input = base;
    input["spec"]["sandboxes"]["assistant"]["runtime"] = json!({"provider": "docker"});
    assert!(!validator.is_valid(&input));
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
}

#[test]
fn a_target_without_exactly_one_known_key_is_rejected_without_defaulting() {
    use nemoclaw_sdk::config::{Document, schema::input_schema};
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for target in [
        json!({}),
        json!(""),
        json!("docker"),
        json!({"docker": {}, "podman": {}}),
        json!({"provider": "docker"}),
    ] {
        let mut input: serde_json::Value =
            serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
        input["spec"]["gateway"]["target"] = target.clone();
        assert!(!validator.is_valid(&input), "{target}");
        assert!(
            Document::parse(input.to_string().as_bytes()).is_err(),
            "{target}"
        );
    }
}

#[test]
fn opaque_adapter_identity_has_no_native_alias_or_default_image() {
    let harness: Harness =
        serde_json::from_value(json!({"kind":"org.fabric.fixture.discoverable"})).unwrap();
    assert_eq!(harness.kind.as_str(), "org.fabric.fixture.discoverable");
    assert_eq!(harness.runtime(), "fabric");
}

#[test]
fn native_schema_fields_are_owned_only_by_fabric_settings() {
    for field in ["interfaces", "observability"] {
        assert!(
            serde_json::from_value::<Harness>(json!({"kind":"org.fixture.adapter",field:{}}))
                .is_err()
        );
    }
    let harness: Harness=serde_json::from_value(json!({"kind":"org.fixture.adapter","settings":{"interfaces":{"future":null},"observability":{"future":true}}})).unwrap();
    assert!(harness.settings.unwrap()["interfaces"]["future"].is_null());
}

#[test]
fn opaque_fabric_identifiers_preserve_owner_valid_long_and_control_values() {
    use nemoclaw_sdk::{
        config::{Document, schema::input_schema},
        fabric_catalog::FabricCatalog,
    };
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for id in [
        format!("org.fabric.{}", "x".repeat(300)),
        "org.fabric.\nfixture\u{1b}".into(),
    ] {
        let mut catalog = FabricCatalog::bundled();
        catalog.adapters[0].descriptor["adapter_id"] = json!(id);
        let catalog = FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).unwrap();
        assert_eq!(catalog.adapters[0].adapter_id(), id);
        let mut input: serde_json::Value =
            serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
        input["spec"]["sandboxes"]["assistant"]["harness"]["kind"] =
            json!(catalog.adapters[0].adapter_id());
        assert!(
            validator.is_valid(&input),
            "schema rejected Fabric identifier"
        );
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        let encoded = document.yaml().unwrap();
        let restored = Document::parse(encoded.as_bytes()).unwrap();
        assert_eq!(
            restored
                .sandbox_harness(restored.sandbox("assistant").unwrap())
                .unwrap()
                .kind
                .as_str(),
            id
        );
    }
}
