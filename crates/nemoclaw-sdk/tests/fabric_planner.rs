// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    fabric_capabilities::plan_configuration,
    fabric_catalog::{FabricAdapter, FabricCatalog},
};
use serde_json::json;

fn catalog() -> FabricCatalog {
    FabricCatalog {
        schema_version: 2,
        fabric_revision: FabricCatalog::bundled().fabric_revision,
        source_sha256: "b".repeat(64),
        targets: Vec::new(),
        adapters: vec![FabricAdapter {
            provenance: json!([{"source":"explicit_local","path":"/image/fixture.fabric-adapter.json","root":"/image"}]),
            descriptor: json!({"contract_version":"fabric.adapter/v1alpha2","adapter_id":"org.fixture.new-adapter","adapter_kind":"python","runner":{"module":"never_imported"},
            "settings_schema":{"type":"object","required":["mode"],"properties":{"mode":{"enum":["simple","advanced"]},"budget":{"type":"integer","minimum":1,"maximum":8}},"if":{"properties":{"mode":{"const":"advanced"}}},"then":{"required":["budget"]}},
            "model_schema":{"type":"object","properties":{"provider":{"const":"openai"},"model":{"pattern":"^fixture-"}},"required":["provider","model"]},
            "config":{"accepts":["models"]}}),
        }],
    }
}
fn config() -> serde_json::Value {
    json!({"schema_version":"fabric.agent/v1alpha1","metadata":{"name":"agent"},"harness":{"adapter_id":"org.fixture.new-adapter","settings":{"mode":"advanced","budget":4}},"runtime":{},"models":{"default":{"provider":"openai","model":"fixture-model"}}})
}

#[test]
fn canonical_fabric_planner_owns_unknown_adapter_settings_and_model_validation() {
    let catalog = catalog();
    let plan = plan_configuration(&catalog, config()).unwrap();
    assert_eq!(plan.config.harness.unwrap().settings["budget"], 4);
    for invalid in [
        json!({"mode":"advanced"}),
        json!({"mode":"advanced","budget":9}),
    ] {
        let mut request = config();
        request["harness"]["settings"] = invalid;
        assert!(plan_configuration(&catalog, request).is_err());
    }
    let mut request = config();
    request["models"]["default"]["model"] = "incorrect".into();
    assert!(plan_configuration(&catalog, request).is_err());
    let mut missing = catalog;
    missing.adapters.clear();
    assert!(plan_configuration(&missing, config()).is_err());
}

#[test]
fn public_fabric_configuration_passes_through_without_overriding_deployment_bindings() {
    use nemoclaw_sdk::config::Document;
    let mut input: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
    input["spec"]["sandboxes"][0]["harness"]["config"] = json!({"mcp":{"servers":{"custom":{"transport":"stdio","url":"owned-fixture","exposure":"harness_native"}}},"runtime":{"max_turns":3}});
    let doc = Document::parse(input.to_string().as_bytes()).unwrap();
    let actual = nemoclaw_sdk::fabric_config::for_sandbox(&doc, &doc.spec.sandboxes[0]).unwrap();
    assert_eq!(actual["runtime"]["max_turns"], 3);
    assert_eq!(
        actual["mcp"],
        input["spec"]["sandboxes"][0]["harness"]["config"]["mcp"]
    );
    input["spec"]["sandboxes"][0]["harness"]["config"]["models"] =
        json!({"default":{"base_url":"https://substituted.invalid"}});
    let doc = Document::parse(input.to_string().as_bytes()).unwrap();
    assert!(nemoclaw_sdk::fabric_config::for_sandbox(&doc, &doc.spec.sandboxes[0]).is_err());
}

#[test]
fn different_fabric_revision_is_unverified_even_when_schema_accepts() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut catalog = catalog();
    catalog.fabric_revision = "0".repeat(40);
    let report = assess_fabric(
        &catalog,
        &FabricRequirements {
            configuration: config(),
            filesystem_read: None,
        },
    );
    assert_eq!(report.status, Support::Unknown);
}

#[test]
fn missing_native_api_contract_is_unknown_but_explicit_exclusion_is_unsupported() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut catalog = catalog();
    let mut configuration = config();
    configuration["models"]["default"]["api"] = "openai-completions".into();
    let request = FabricRequirements {
        configuration,
        filesystem_read: None,
    };
    assert_eq!(assess_fabric(&catalog, &request).status, Support::Unknown);
    catalog.adapters[0].descriptor["extension_schemas"] = json!({"model":{"type":"object","properties":{"api":{"enum":["anthropic-messages"]}},"additionalProperties":false}});
    assert_eq!(
        assess_fabric(&catalog, &request).status,
        Support::Unsupported
    );
}

#[test]
fn canonical_workflow_targets_are_planned_from_the_image_snapshot_only() {
    let mut raw = serde_json::to_value(catalog()).unwrap();
    raw["adapters"][0]["descriptor"]["target_types"] = json!(["workflow"]);
    raw["targets"] = json!([{
        "descriptor": {"contract_version":"fabric.adapter/v1alpha2","type":"workflow","id":"org.fixture.workflow","adapter_id":"org.fixture.new-adapter","spec":{"entrypoint":{"kind":"interactive_agent_factory","ref":"fixture:factory"},"settings_schema":{"type":"object","required":["budget"],"properties":{"budget":{"type":"integer","minimum":1}},"additionalProperties":false}}},
        "provenance":[{"source":"explicit_local","path":"/image/fixture.fabric-target.json","root":"/image"}]
    }]);
    let catalog = FabricCatalog::from_json(&raw.to_string()).unwrap();
    let mut request = config();
    request["workflow"] = json!({"target_id":"org.fixture.workflow","settings":{"budget":4}});
    let plan = plan_configuration(&catalog, request.clone()).unwrap();
    assert!(plan.adapter_target_descriptor.is_some());
    request["workflow"]["settings"]["budget"] = 0.into();
    assert!(plan_configuration(&catalog, request.clone()).is_err());
    raw["targets"] = json!([]);
    request["workflow"]["settings"]["budget"] = 4.into();
    let absent = FabricCatalog::from_json(&raw.to_string()).unwrap();
    assert!(plan_configuration(&absent, request).is_err());
}
