// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A journey can offer a curated subset of the catalog's harnesses.

use nemoclaw_authoring::{Capabilities, JourneyDefinition, PartialDocument};
use serde_json::{Value, json};

const HARNESS: &str = "/spec/sandboxes/assistant/harness/kind";
const OPENCLAW: &str = "nvidia.fabric.openclaw";
const HERMES: &str = "nvidia.fabric.hermes";
const CLAUDE: &str = "nvidia.fabric.claude";

fn template(harness: &str) -> Value {
    let mut values: Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["sandboxes"]["assistant"]["harness"]["kind"] = json!(harness);
    values
}

fn definition(values: Value) -> JourneyDefinition {
    JourneyDefinition::new(
        "offering",
        PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap(),
    )
    .ask([HARNESS])
}

fn menu(definition: &JourneyDefinition, capabilities: &Capabilities) -> Vec<Value> {
    let state = definition.start(capabilities).unwrap();
    let resolution = state.resolve(capabilities).unwrap();
    resolution.question(HARNESS).unwrap().choices().to_vec()
}

#[test]
fn offered_harnesses_replace_the_catalog_menu_in_the_offered_order() {
    let capabilities = Capabilities::available();
    let definition = definition(template(OPENCLAW)).offer_harnesses([OPENCLAW, HERMES]);
    assert_eq!(
        menu(&definition, &capabilities),
        [json!(OPENCLAW), json!(HERMES)]
    );
}

#[test]
fn a_definition_without_an_offering_keeps_every_catalog_harness() {
    let capabilities = Capabilities::available();
    let all: Vec<Value> = capabilities
        .harnesses()
        .iter()
        .map(|kind| json!(kind.as_str()))
        .collect();
    assert_eq!(menu(&definition(template(OPENCLAW)), &capabilities), all);
}

#[test]
fn a_template_harness_outside_the_offering_stays_suggested_and_joins_the_menu() {
    let capabilities = Capabilities::available();
    let definition = definition(template(CLAUDE)).offer_harnesses([OPENCLAW, HERMES]);
    let state = definition.start(&capabilities).unwrap();
    let resolution = state.resolve(&capabilities).unwrap();
    let question = resolution.question(HARNESS).unwrap();
    assert_eq!(question.suggestion(), Some(&json!(CLAUDE)));
    assert_eq!(
        question.choices(),
        [json!(OPENCLAW), json!(HERMES), json!(CLAUDE)]
    );
}

#[test]
fn an_offered_harness_the_catalog_lacks_is_kept_with_a_warning_and_not_listed() {
    let capabilities = Capabilities::available();
    let definition =
        definition(template(OPENCLAW)).offer_harnesses([OPENCLAW, "nvidia.fabric.missing"]);
    assert_eq!(menu(&definition, &capabilities), [json!(OPENCLAW)]);
    let state = definition.start(&capabilities).unwrap();
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(
        resolution
            .warnings()
            .iter()
            .any(|warning| warning.contains("nvidia.fabric.missing")),
        "{:?}",
        resolution.warnings()
    );
}

#[test]
fn an_empty_offering_is_rejected() {
    let capabilities = Capabilities::available();
    let empty: [&str; 0] = [];
    assert!(
        definition(template(OPENCLAW))
            .offer_harnesses(empty)
            .start(&capabilities)
            .is_err()
    );
}

#[test]
fn the_tree_preview_lists_only_the_offered_harnesses() {
    let capabilities = Capabilities::available();
    let tree = definition(template(OPENCLAW))
        .offer_harnesses([OPENCLAW, HERMES])
        .print_tree(&capabilities)
        .unwrap();
    assert!(tree.contains(HERMES), "{tree}");
    assert!(!tree.contains(CLAUDE), "{tree}");
}
