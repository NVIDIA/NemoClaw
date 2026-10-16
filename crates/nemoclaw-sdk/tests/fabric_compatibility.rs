// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::fabric_catalog::{FabricAdapter, FabricCatalog};
use serde_json::json;

fn catalog() -> FabricCatalog {
    FabricCatalog {
        schema_version: 2,
        fabric_revision: FabricCatalog::bundled().fabric_revision,
        source_sha256: "b".repeat(64),
        bridge: None,
        targets: Vec::new(),
        adapters: vec![FabricAdapter {
            provenance: json!([{"source":"explicit_local","path":"/image/fixture.fabric-adapter.json","root":"/image"}]),
            descriptor: json!({"contract_version":"fabric.adapter/v1alpha2","adapter_id":"org.fixture.new-adapter","adapter_kind":"python","runner":{"module":"never_imported"},
            "settings_schema":{"type":"object","required":["mode"],"properties":{"mode":{"enum":["simple","advanced"]},"budget":{"type":"integer","minimum":1,"maximum":8}},"if":{"properties":{"mode":{"const":"advanced"}}},"then":{"required":["budget"]}},
            "model_schema":{"type":"object","properties":{"provider":{"const":"openai"},"model":{"pattern":"^fixture-"}},"required":["provider","model"]},
            "config":{"accepts":["models"]}}),
        }],
        runtime_files: Default::default(),
        runtime: None,
    }
}
fn config() -> serde_json::Value {
    json!({"schema_version":"fabric.agent/v1alpha1","metadata":{"name":"agent"},"harness":{"adapter_id":"org.fixture.new-adapter","settings":{"mode":"advanced","budget":4}},"runtime":{},"models":{"default":{"provider":"openai","model":"fixture-model"}}})
}

/// An image without the selected harness can never run it, so the image is
/// unsupported for the configuration rather than unverified.
#[test]
fn an_image_without_the_selected_adapter_is_unsupported_on_the_adapter_id() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut configuration = config();
    configuration["harness"]["adapter_id"] = "org.fixture.absent-adapter".into();
    let report = assess_fabric(
        &catalog(),
        &FabricRequirements {
            configuration,
            filesystem_read: None,
        },
    );
    assert_eq!(report.status, Support::Unsupported);
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.status == Support::Unsupported
                && check.reason.starts_with("harness.adapter_id:")),
        "{:?}",
        report.checks
    );
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
fn different_fabric_revision_is_unverified_even_when_the_configuration_is_valid() {
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
fn explicit_filesystem_policy_must_allow_the_image_runtime_directory() {
    use nemoclaw_sdk::fabric_capabilities::{
        CapabilityCheck, FabricRequirements, Support, assess_fabric,
    };
    let mut catalog = catalog();
    catalog
        .runtime_files
        .insert("org.fixture.new-adapter".into(), vec!["/opt/hermes".into()]);
    let grants = |grants: Vec<&str>| FabricRequirements {
        configuration: config(),
        filesystem_read: Some(grants.into_iter().map(str::to_owned).collect()),
    };
    let report = assess_fabric(
        &catalog,
        &grants(vec!["/usr", "/opt/fabric", "/opt/nemoclaw"]),
    );
    assert_eq!(report.status, Support::Unsupported);
    assert!(report.checks.contains(&CapabilityCheck {
        requirement: "deployment_filesystem_grant".into(),
        status: Support::Unsupported,
        reason: "explicit filesystem policy must grant read access to /opt/hermes".into(),
    }));
    assert_eq!(
        assess_fabric(&catalog, &grants(vec!["/opt/hermes/web"])).status,
        Support::Unsupported
    );
    assert_eq!(
        assess_fabric(&catalog, &grants(vec!["/usr", "/opt"])).status,
        Support::Supported
    );
    let without_policy = FabricRequirements {
        configuration: config(),
        filesystem_read: None,
    };
    assert_eq!(
        assess_fabric(&catalog, &without_policy).status,
        Support::Supported
    );
}

#[test]
fn image_compatibility_requires_a_matching_bridge_contract() {
    use nemoclaw_sdk::fabric_capabilities::{
        FabricRequirements, ImageMetadata, Support, assess_image,
    };
    let reference = format!("fixture@sha256:{}", "a".repeat(64));
    let image = ImageMetadata {
        repo_digests: vec![reference.clone()],
        ..Default::default()
    };
    let request = FabricRequirements {
        configuration: config(),
        filesystem_read: None,
    };
    let bridge = json!({
        "interface_version": 1,
        "operations": ["validate", "prepare", "configure", "check", "invoke", "serve"],
        "health_checks": []
    });
    let mut raw = serde_json::to_value(catalog()).unwrap();
    let status = |raw: &serde_json::Value| {
        let catalog = FabricCatalog::from_json(&raw.to_string()).unwrap();
        assess_image(Some(&catalog), &request, &image, &reference, None, None).status
    };
    assert_eq!(status(&raw), Support::Unknown);
    raw["bridge"] = bridge.clone();
    assert_eq!(status(&raw), Support::Supported);
    // Interface version 1 is one exact shape; images built for another are rebuilt.
    raw["bridge"]["input_sources"] = json!(["file", "stdin"]);
    assert!(FabricCatalog::from_json(&raw.to_string()).is_err());
    raw["bridge"] = bridge.clone();
    raw["bridge"]["interface_version"] = 2.into();
    assert_eq!(status(&raw), Support::Unknown);
    raw["bridge"] = bridge.clone();
    raw["bridge"]["operations"] = json!(["configure", "check"]);
    assert_eq!(status(&raw), Support::Unknown);
    raw["bridge"] = bridge.clone();
    raw["bridge"]["health_checks"] = json!(["ready"]);
    assert_eq!(status(&raw), Support::Unknown);
    raw["bridge"] = bridge;
    raw["bridge"]["health_checks"] = json!(["live", "active", "ready"]);
    assert_eq!(status(&raw), Support::Supported);
}

#[test]
fn relocated_image_runtime_read_requirements_replace_client_layout_assumptions() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut catalog = catalog();
    let mut runtime: serde_json::Value =
        serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
    runtime["required_paths"] = json!(["/srv/runtime"]);
    runtime["binaries"] = json!({"org.fixture.new-adapter":["/srv/runtime/python3.99"]});
    catalog.runtime = Some(serde_json::from_value(runtime).unwrap());
    for (paths, expected) in [
        (
            vec!["/usr", "/opt/fabric", "/opt/nemoclaw"],
            Support::Unsupported,
        ),
        (vec!["/srv/runtime-other"], Support::Unsupported),
        (vec!["/srv/runtime/../other"], Support::Unsupported),
        (vec!["/srv"], Support::Supported),
        (vec!["/srv/runtime"], Support::Supported),
    ] {
        let report = assess_fabric(
            &catalog,
            &FabricRequirements {
                configuration: config(),
                filesystem_read: Some(paths.into_iter().map(String::from).collect()),
            },
        );
        assert_eq!(report.status, expected, "{:?}", report.checks);
    }
}

#[test]
fn explicit_filesystem_grants_reject_nul_in_required_paths_and_grants() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    for (path, grant) in [
        ("/opt/hermes\0private", "/opt"),
        ("/opt\0private/hermes", "/opt\0private"),
    ] {
        let mut catalog = catalog();
        catalog
            .runtime_files
            .insert("org.fixture.new-adapter".into(), vec![path.into()]);
        let report = assess_fabric(
            &catalog,
            &FabricRequirements {
                configuration: config(),
                filesystem_read: Some(vec![grant.into()]),
            },
        );
        assert_eq!(report.status, Support::Unsupported, "{path:?} in {grant:?}");
        assert!(report.checks.iter().any(|check| {
            check.requirement == "deployment_filesystem_grant"
                && check.status == Support::Unsupported
        }));
    }
}

/// Whether a harness accepts a configuration is Fabric's to decide, when the
/// agent is configured in its sandbox. NemoClaw only establishes that the image
/// provides the selected adapter.
#[test]
fn whether_a_harness_accepts_a_configuration_is_left_to_fabric() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut configuration = config();
    // The adapter's settings schema allows a budget of at most 8.
    configuration["harness"]["settings"]["budget"] = 9.into();
    let report = assess_fabric(
        &catalog(),
        &FabricRequirements {
            configuration,
            filesystem_read: None,
        },
    );
    assert_eq!(report.status, Support::Supported, "{:?}", report.checks);
    assert!(
        report
            .checks
            .iter()
            .all(|check| check.requirement != "fabric_plan"),
        "{:?}",
        report.checks
    );
}

#[test]
fn generated_base_urls_go_only_to_adapters_that_accept_them() {
    // Fabric rejects a normalized field an adapter does not accept, so the SDK
    // sends its generated base URL only where the descriptor accepts one.
    let remote = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../examples/fabric-remote-agent.yaml").as_slice(),
    )
    .unwrap();
    let config =
        nemoclaw_sdk::fabric_config::for_sandbox(&remote, &remote.spec.sandboxes[0]).unwrap();
    assert!(
        config["models"]["default"].get("base_url").is_none(),
        "{config}"
    );
    assert!(
        config["models"]["default"]["api_key_env"].is_string(),
        "{config}"
    );

    let openclaw = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../examples/openclaw.yaml").as_slice(),
    )
    .unwrap();
    let config =
        nemoclaw_sdk::fabric_config::for_sandbox(&openclaw, &openclaw.spec.sandboxes[0]).unwrap();
    assert_eq!(
        config["models"]["default"]["base_url"],
        "https://inference.example.com/v1"
    );
}

#[test]
fn declared_model_extensions_get_the_provider_api_and_authored_fields() {
    // Pi declares `api`, `context_window`, and `max_tokens` as model extensions.
    let pi = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../examples/fabric-pi.yaml").as_slice(),
    )
    .unwrap();
    let model = &nemoclaw_sdk::fabric_config::for_sandbox(&pi, &pi.spec.sandboxes[0]).unwrap()["models"]
        ["default"];
    assert_eq!(model["api"], "openai-completions", "{model}");
    assert_eq!(model["context_window"], 32768, "{model}");
    assert_eq!(model["max_tokens"], 4096, "{model}");

    // OpenClaw declares no model `api`, so none is sent.
    let text = include_str!("../../../examples/openclaw.yaml");
    let openclaw = nemoclaw_sdk::config::Document::parse(text.as_bytes()).unwrap();
    let config =
        nemoclaw_sdk::fabric_config::for_sandbox(&openclaw, &openclaw.spec.sandboxes[0]).unwrap();
    assert!(config["models"]["default"].get("api").is_none(), "{config}");

    // Extensions cannot replace a field the deployment sets.
    let reserved = text.replace(
        "                maxTokens: 8192\n",
        "                maxTokens: 8192\n                extensions:\n                  base_url: https://elsewhere.example.com/v1\n",
    );
    assert_ne!(reserved, text);
    let reserved = nemoclaw_sdk::config::Document::parse(reserved.as_bytes()).unwrap();
    assert!(
        nemoclaw_sdk::fabric_config::for_sandbox(&reserved, &reserved.spec.sandboxes[0]).is_err()
    );
}
