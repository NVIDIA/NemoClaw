// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{Capabilities, JourneyDefinition, JourneyScope, PartialDocument};
use nemoclaw_sdk::fabric_catalog::FabricCatalog;

#[test]
fn printed_tree_identifies_its_sdk_schema_and_exact_fabric_catalog() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition = JourneyDefinition::new("provenance", base);
    let mut catalog = FabricCatalog::bundled();
    let tree = definition
        .print_tree(&Capabilities::from_catalog(&catalog))
        .unwrap();
    let sdk_line = tree
        .lines()
        .find(|line| line.contains("SDK schema:"))
        .unwrap();
    let sdk_digest = sdk_line.split("sha256:").nth(1).unwrap();
    assert_eq!(sdk_digest.len(), 64);
    assert!(sdk_digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(tree.contains(&format!("Fabric revision: {}", catalog.fabric_revision)));
    let catalog_line = tree
        .lines()
        .find(|line| line.contains("Fabric catalog sha256:"))
        .unwrap()
        .to_owned();

    catalog.adapters.pop();
    let changed = definition
        .print_tree(&Capabilities::from_catalog(&catalog))
        .unwrap();
    let changed_line = changed
        .lines()
        .find(|line| line.contains("Fabric catalog sha256:"))
        .unwrap();
    assert_ne!(catalog_line, changed_line);
    let synthetic = definition
        .print_tree(&Capabilities::from_harnesses([]))
        .unwrap();
    assert!(synthetic.contains("Fabric catalog: unverified"));
}

#[test]
fn configured_native_questions_appear_in_the_same_definition_tree() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition = JourneyDefinition::new("native", base).ask([JourneyScope::NativeSettings]);
    let capabilities = Capabilities::available();
    let state = definition.start(&capabilities).unwrap();
    let resolution = state.resolve(&capabilities).unwrap();
    let question = resolution
        .questions()
        .iter()
        .find(|question| question.id().starts_with("model:"))
        .expect("native model question");
    let tree = definition.print_tree(&capabilities).unwrap();
    assert!(tree.contains(question.id()), "{tree}");
}

#[test]
fn minimum_values_preview_shows_harness_branches_and_optional_omission() {
    let base = PartialDocument::from_yaml(
        b"apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\nspec:\n  sandboxes:\n    - {}\n",
    )
    .unwrap();
    let journey = JourneyDefinition::new("minimum-values", base)
        .ask(["/metadata/name"])
        .omit(["adapter:nvidia.fabric.openclaw:/cli"]);
    let tree = journey.print_tree(&Capabilities::available()).unwrap();

    assert!(tree.contains("/metadata/name"));
    assert!(tree.contains("/spec/sandboxes/0/name"));
    assert!(tree.contains("/spec/sandboxes/0/agent/name"));
    assert!(
        tree.contains("Choices for form:/spec/sandboxes/0:"),
        "{tree}"
    );
    assert!(tree.contains("├─ harnessRef"), "{tree}");
    assert!(
        tree.contains("Choices for /spec/sandboxes/0/harness/kind:"),
        "{tree}"
    );
    assert!(tree.contains("nvidia.fabric.openclaw"));
    assert!(tree.contains("/cli: omitted"));
    assert!(tree.contains("Other unresolved SDK constraints"));
}

#[test]
fn supplied_document_with_explicit_optional_omissions_has_no_preview_questions() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let journey = JourneyDefinition::new("express", base).omit([
        "adapter:nvidia.fabric.openclaw:/agent_name",
        "adapter:nvidia.fabric.openclaw:/cli",
        "adapter:nvidia.fabric.openclaw:/home",
        "adapter:nvidia.fabric.openclaw:/native_config",
        "adapter:nvidia.fabric.openclaw:/timeout_seconds",
    ]);
    let tree = journey.print_tree(&Capabilities::available()).unwrap();

    assert!(tree.contains("No configuration questions"), "{tree}");
}

#[test]
fn unsupported_guidance_is_rejected_instead_of_disappearing_from_preview() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let journey = JourneyDefinition::new("unsupported", base).ask(["/spec/gateway/notAField"]);

    assert!(journey.print_tree(&Capabilities::available()).is_err());
}

#[test]
fn guided_sdk_questions_are_visible_in_the_tree_without_printing_suggestions() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let journey = JourneyDefinition::new("guided-sdk", base).ask([
        "/spec/inferenceProviders/0/api",
        "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
    ]);
    let tree = journey.print_tree(&Capabilities::available()).unwrap();
    assert!(tree.contains("/spec/inferenceProviders/0/api"), "{tree}");
    assert!(
        tree.contains("/spec/sandboxes/0/agent/inference/routes/0/overrides/model"),
        "{tree}"
    );
    assert!(
        !tree.contains("nvidia/nemotron-3-super-120b-a12b"),
        "{tree}"
    );
    assert!(!tree.contains("No configuration questions"), "{tree}");
}

#[test]
fn inference_preset_preview_shows_custom_endpoint_branch() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let journey = JourneyDefinition::new("preset", base).ask([
        "inference:preset",
        "/spec/inferenceProviders/0/api",
        "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
    ]);
    let tree = journey.print_tree(&Capabilities::available()).unwrap();
    assert!(tree.contains("inference:preset"), "{tree}");
    assert!(tree.contains("openai-compatible"), "{tree}");
    assert!(
        tree.contains("/spec/inferenceProviders/0/endpoint"),
        "{tree}"
    );
    assert!(
        tree.contains("/spec/sandboxes/0/agent/inference/routes/0/overrides/model"),
        "{tree}"
    );
    assert!(!tree.contains("https://inference.example.com/v1"), "{tree}");
}

#[test]
fn preview_does_not_print_supplied_native_setting_values() {
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base.pointer_mut("/spec/sandboxes/0/harness")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .insert(
            "settings".into(),
            serde_json::json!({"cli":"SECRET_SENTINEL"}),
        );
    let base = PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap();
    let journey =
        JourneyDefinition::new("secret-safe", base).ask(["adapter:nvidia.fabric.openclaw:/cli"]);
    let tree = journey.print_tree(&Capabilities::available()).unwrap();

    assert!(tree.contains("/cli"));
    assert!(!tree.contains("SECRET_SENTINEL"));
}

#[test]
fn omission_is_scoped_to_its_adapter() {
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let harness = base.pointer_mut("/spec/sandboxes/0/harness").unwrap();
    harness["kind"] = serde_json::json!("nvidia.fabric.hermes");
    harness["settings"] = serde_json::json!({"cli": "from-other-adapter"});
    let base = PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap();
    let journey =
        JourneyDefinition::new("adapter-scope", base).omit(["adapter:nvidia.fabric.openclaw:/cli"]);

    let tree = journey.print_tree(&Capabilities::available()).unwrap();
    assert!(!tree.contains("/cli: omitted"));
}

#[test]
fn unreachable_adapter_guidance_is_warned_about_without_rejecting_the_journey() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let journey = JourneyDefinition::new("fixed-openclaw", base)
        .ask(["adapter:nvidia.fabric.hermes:/mode"])
        .omit(["adapter:nvidia.fabric.hermes:/api_mode"]);

    let tree = journey.print_tree(&Capabilities::available()).unwrap();
    assert!(
        tree.contains("Warning: adapter:nvidia.fabric.hermes:/mode"),
        "{tree}"
    );
    assert!(
        tree.contains("Warning: adapter:nvidia.fabric.hermes:/api_mode"),
        "{tree}"
    );
    assert!(
        tree.contains("not reachable from selected harness"),
        "{tree}"
    );
}

#[test]
fn invalid_supplied_name_remains_visible_in_the_preview() {
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["metadata"]["name"] = serde_json::json!("Bad Name");
    let base = PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap();
    let journey = JourneyDefinition::new("invalid-name", base);

    let tree = journey.print_tree(&Capabilities::available()).unwrap();
    assert!(tree.contains("/metadata/name: Invalid"), "{tree}");
    assert!(!tree.contains("No configuration questions"), "{tree}");
}

#[test]
fn invalid_supplied_sdk_leaf_is_visible_without_printing_its_value() {
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["sandboxes"][0]["name"] = serde_json::json!("PRIVATE INVALID NAME");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let tree = JourneyDefinition::new("invalid-sandbox", base)
        .print_tree(&Capabilities::available())
        .unwrap();
    assert!(tree.contains("/spec/sandboxes/0/name: <string>"), "{tree}");
    assert!(tree.contains("invalid supplied value"), "{tree}");
    assert!(!tree.contains("PRIVATE INVALID NAME"), "{tree}");
}

#[test]
fn harness_without_a_fabric_schema_does_not_claim_zero_questions() {
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["spec"]["sandboxes"][0]["harness"]["kind"] =
        serde_json::json!("nvidia.fabric.unsupported");
    let base = PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap();
    let journey = JourneyDefinition::new("invalid-harness", base);

    let tree = journey.print_tree(&Capabilities::available()).unwrap();
    assert!(tree.contains("adapter schema unverified"), "{tree}");
    assert!(!tree.contains("No configuration questions"), "{tree}");
}

#[test]
fn invalid_fabric_setting_is_labeled_without_printing_its_value() {
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["spec"]["sandboxes"][0]["harness"]["settings"] = serde_json::json!({"cli": 42});
    let base = PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap();

    let tree = JourneyDefinition::new("invalid-setting", base)
        .print_tree(&Capabilities::available())
        .unwrap();
    assert!(tree.contains("/cli: [omit | <string>]"), "{tree}");
    assert!(tree.contains("invalid supplied value"), "{tree}");
    assert!(!tree.contains("42"), "{tree}");
}

#[test]
fn tree_branches_on_finite_sdk_choices_from_the_resolver() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition =
        JourneyDefinition::new("api-choices", base).ask(["/spec/inferenceProviders/0/api"]);
    let capabilities = Capabilities::available();
    let resolution = definition
        .start(&capabilities)
        .unwrap()
        .resolve(&capabilities)
        .unwrap();
    let question = resolution
        .question("/spec/inferenceProviders/0/api")
        .unwrap();
    assert!(question.choices().len() > 1);
    let tree = definition.print_tree(&capabilities).unwrap();
    for choice in question.choices() {
        assert!(
            tree.contains(&format!("├─ {}", choice.as_str().unwrap())),
            "{tree}"
        );
    }
}

#[test]
fn tree_does_not_print_supplied_route_names_as_choice_labels() {
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let routes = values
        .pointer_mut("/spec/sandboxes/0/agent/inference/routes")
        .unwrap()
        .as_array_mut()
        .unwrap();
    let mut other = routes[0].clone();
    other["name"] = serde_json::json!("private-route-name");
    routes.push(other);
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let tree = JourneyDefinition::new("routes", base)
        .ask([JourneyScope::RouteModels])
        .print_tree(&Capabilities::available())
        .unwrap();
    assert!(tree.contains("route:selection"), "{tree}");
    assert!(!tree.contains("private-route-name"), "{tree}");
}

#[test]
fn tree_exposes_schema_derived_gateway_branches_without_supplied_values() {
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["gateway"] = serde_json::json!({});
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let tree = JourneyDefinition::new("gateway-branches", base)
        .print_tree(&Capabilities::available())
        .unwrap();
    assert!(
        tree.contains("Choices for /spec/gateway/management"),
        "{tree}"
    );
    assert!(tree.contains("├─ managed"), "{tree}");
    assert!(tree.contains("├─ external"), "{tree}");
    assert!(tree.contains("/spec/gateway/endpoint"), "{tree}");
}

#[test]
fn tree_branches_on_sdk_exclusive_forms() {
    let capabilities = Capabilities::available();
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["sandboxes"][0]["agent"]
        .as_object_mut()
        .unwrap()
        .remove("inference");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let tree = JourneyDefinition::new("agent-form", base)
        .print_tree(&capabilities)
        .unwrap();
    assert!(
        tree.contains("Choices for form:/spec/sandboxes/0/agent"),
        "{tree}"
    );
    assert!(
        tree.contains("/spec/sandboxes/0/agent/inferenceRef: <string>"),
        "{tree}"
    );
}

#[test]
fn minimum_inline_fixture_prints_the_questions_it_can_materialize() {
    let base = PartialDocument::from_yaml(include_bytes!("fixtures/minimum-inline.yaml")).unwrap();
    let tree = JourneyDefinition::new("minimum-inline", base)
        .print_tree(&Capabilities::available())
        .unwrap();
    for field in [
        "/metadata/name",
        "/spec/gateway/management",
        "/spec/sandboxes/0/harness/kind",
        "/spec/sandboxes/0/agent/inference/routes/0/name",
        "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
    ] {
        assert!(tree.contains(field), "missing {field}: {tree}");
    }
    assert!(tree.contains("/spec/gateway/endpoint"), "{tree}");
}
