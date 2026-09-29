// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{Capabilities, JourneyDefinition, PartialDocument};

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
    let journey = JourneyDefinition::new("unsupported", base).ask(["/spec/gateway/engine"]);

    assert!(journey.print_tree(&Capabilities::available()).is_err());
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
