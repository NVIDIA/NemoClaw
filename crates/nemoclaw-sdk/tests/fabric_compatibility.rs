// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::fabric_catalog::{FabricAdapter, FabricCatalog};
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
    input["spec"]["sandboxes"]["assistant"]["harness"]["config"] = json!({
        "mcp":{"servers":{"custom":{"transport":"stdio","url":"owned-fixture","exposure":"harness_native"}}},
        "relay":{"plugins":{"dynamic":[{"manifest":"/plugins/example/relay-plugin.toml","config":{"mode":"route"}}]}},
        "runtime":{"max_turns":3}
    });
    let doc = Document::parse(input.to_string().as_bytes()).unwrap();
    let actual =
        nemoclaw_sdk::fabric_config::for_sandbox(&doc, doc.sandbox("assistant").unwrap()).unwrap();
    assert_eq!(actual["runtime"]["max_turns"], 3);
    assert_eq!(
        actual["mcp"],
        input["spec"]["sandboxes"]["assistant"]["harness"]["config"]["mcp"]
    );
    assert_eq!(
        actual["relay"],
        input["spec"]["sandboxes"]["assistant"]["harness"]["config"]["relay"]
    );
    input["spec"]["sandboxes"]["assistant"]["harness"]["config"]["models"] =
        json!({"default":{"base_url":"https://substituted.invalid"}});
    let doc = Document::parse(input.to_string().as_bytes()).unwrap();
    assert!(
        nemoclaw_sdk::fabric_config::for_sandbox(&doc, doc.sandbox("assistant").unwrap()).is_err()
    );
}

#[test]
fn a_different_fabric_revision_is_left_to_fabric() {
    // The image's own Fabric reports an incompatible runtime when the agent
    // starts; NemoClaw doesn't compare revisions.
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
    assert_eq!(report.status, Support::Supported, "{report:?}");
    assert!(
        report
            .checks
            .iter()
            .all(|check| check.requirement != "fabric_contract")
    );
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

/// Images run Fabric's own `fabric-agent-ctl`, which reports interface
/// mismatches itself, so compatibility needs no bridge record.
#[test]
fn image_compatibility_needs_no_bridge_record() {
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
    let catalog = catalog();
    assert_eq!(
        assess_image(Some(&catalog), &request, &image, &reference, None, None).status,
        Support::Supported
    );
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

/// The interface checks of a report: the rejected setting paths, in order.
fn rejected_interfaces(
    catalog: &FabricCatalog,
    adapter_id: &str,
    interfaces: serde_json::Value,
) -> Vec<String> {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut configuration = config();
    configuration["harness"]["adapter_id"] = adapter_id.into();
    configuration["harness"]["settings"] = json!({ "interfaces": interfaces });
    let report = assess_fabric(
        catalog,
        &FabricRequirements {
            configuration,
            filesystem_read: None,
        },
    );
    let rejected: Vec<String> = report
        .checks
        .iter()
        .filter(|check| check.status == Support::Unsupported)
        .map(|check| {
            assert_eq!(check.requirement, "harness_interfaces", "{check:?}");
            check
                .reason
                .split_once(':')
                .map(|(path, _)| path.to_owned())
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(
        report.status == Support::Unsupported,
        !rejected.is_empty(),
        "{:?}",
        report.checks
    );
    rejected
}

/// The fixture adapter with an interface declaration like a P0 adapter's:
/// `dashboard`, taking `enabled` and `port`.
fn catalog_with_interfaces() -> FabricCatalog {
    let mut catalog = catalog();
    catalog.adapters[0].descriptor["settings_schema"]["properties"]["interfaces"] = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {"dashboard": {
            "type": "object",
            "additionalProperties": false,
            "required": ["port"],
            "properties": {"enabled": {"type": "boolean"}, "port": {"type": "integer"}}
        }}
    });
    catalog
}

/// Planning rejects an interface or interface field that the image's adapter
/// doesn't declare, naming the setting, so the plan fails before apply.
#[test]
fn planning_rejects_interfaces_and_fields_the_adapter_does_not_declare() {
    let catalog = catalog_with_interfaces();
    let adapter = "org.fixture.new-adapter";
    assert!(
        rejected_interfaces(&catalog, adapter, json!({"dashboard": {"port": 9119}})).is_empty()
    );
    assert!(
        rejected_interfaces(
            &catalog,
            adapter,
            json!({"dashboard": {"enabled": false, "port": 9119}})
        )
        .is_empty()
    );
    assert_eq!(
        rejected_interfaces(&catalog, adapter, json!({"terminal": {}})),
        ["harness.settings.interfaces.terminal"]
    );
    assert_eq!(
        rejected_interfaces(
            &catalog,
            adapter,
            json!({"dashboard": {"port": 9119, "public_origins": ["https://a.example"]}, "api": {"port": 8642}})
        ),
        [
            "harness.settings.interfaces.api",
            "harness.settings.interfaces.dashboard.public_origins"
        ]
    );
}

/// An adapter whose descriptor declares no interfaces supports none.
#[test]
fn an_adapter_without_an_interface_declaration_supports_no_interfaces() {
    let adapter = "org.fixture.new-adapter";
    assert_eq!(
        rejected_interfaces(&catalog(), adapter, json!({"dashboard": {"port": 9119}})),
        ["harness.settings.interfaces.dashboard"]
    );
    assert_eq!(
        rejected_interfaces(&catalog(), adapter, json!(true)),
        ["harness.settings.interfaces"]
    );
}

/// Values, required fields and combinations, such as a missing port or one out
/// of range, are Fabric's to check when it plans the agent.
#[test]
fn interface_values_are_left_to_fabric() {
    let catalog = catalog_with_interfaces();
    let adapter = "org.fixture.new-adapter";
    for interfaces in [
        json!({"dashboard": {}}),
        json!({"dashboard": {"port": 0}}),
        json!({"dashboard": {"port": "9119", "enabled": "yes"}}),
    ] {
        assert!(rejected_interfaces(&catalog, adapter, interfaces).is_empty());
    }
}

/// A name that isn't safe to print is reported without echoing it.
#[test]
fn an_unsupported_interface_name_is_never_echoed_unsafely() {
    let rejected = rejected_interfaces(
        &catalog_with_interfaces(),
        "org.fixture.new-adapter",
        json!({"\u{1b}[31mPRIVATE": {}}),
    );
    assert_eq!(rejected, ["harness.settings.interfaces"]);
}

/// The bundled OpenClaw and Hermes adapters declare their P0 interfaces.
#[test]
fn the_bundled_adapters_accept_their_p0_interfaces_only() {
    let catalog = FabricCatalog::bundled();
    let openclaw = "nvidia.fabric.openclaw";
    let hermes = "nvidia.fabric.hermes";
    assert!(
        rejected_interfaces(
            &catalog,
            openclaw,
            json!({"dashboard": {"enabled": true, "port": 18789, "public_origins": ["https://claw.example"]}})
        )
        .is_empty()
    );
    assert_eq!(
        rejected_interfaces(&catalog, openclaw, json!({"api": {"port": 8642}})),
        ["harness.settings.interfaces.api"]
    );
    assert!(
        rejected_interfaces(
            &catalog,
            hermes,
            json!({"api": {"port": 8642}, "dashboard": {"enabled": true, "port": 9119}})
        )
        .is_empty()
    );
    assert_eq!(
        rejected_interfaces(
            &catalog,
            hermes,
            json!({"dashboard": {"port": 9119, "public_origins": ["https://h.example"]}, "terminal": {}})
        ),
        [
            "harness.settings.interfaces.dashboard.public_origins",
            "harness.settings.interfaces.terminal"
        ]
    );
    assert_eq!(
        rejected_interfaces(&catalog, "nvidia.fabric.pi", json!({"terminal": {}})),
        ["harness.settings.interfaces.terminal"]
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
        nemoclaw_sdk::fabric_config::for_sandbox(&remote, remote.sandbox("assistant").unwrap())
            .unwrap();
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
        nemoclaw_sdk::fabric_config::for_sandbox(&openclaw, openclaw.sandbox("assistant").unwrap())
            .unwrap();
    assert_eq!(
        config["models"]["default"]["base_url"],
        "https://inference.example.com/v1"
    );
}

#[test]
fn opencode_trusts_the_plain_http_model_hosts_the_deployment_names() {
    // Fabric's OpenCode adapter refuses a plain-HTTP model endpoint outside
    // loopback unless its harness settings list the host, so the deployment
    // lists the hosts of the endpoints it sends.
    let text = include_str!("../../../examples/fabric-opencode.yaml");
    let project = |text: &str| {
        let doc = nemoclaw_sdk::config::Document::parse(text.as_bytes()).unwrap();
        nemoclaw_sdk::fabric_config::for_sandbox(&doc, doc.sandboxes().next().unwrap()).unwrap()
    };
    let config = project(text);
    assert_eq!(
        config["models"]["default"]["base_url"],
        "http://172.20.0.1:11446/v1"
    );
    assert_eq!(
        config["harness"]["settings"]["insecure_http_model_hosts"],
        json!(["172.20.0.1"]),
        "{config}"
    );

    // An authored host stays beside the endpoint's.
    let authored = text.replace(
        "        kind: nvidia.fabric.opencode\n",
        "        kind: nvidia.fabric.opencode\n        settings:\n          insecure_http_model_hosts: [models.example.com]\n",
    );
    assert_ne!(authored, text);
    let config = project(&authored);
    assert_eq!(
        config["harness"]["settings"]["insecure_http_model_hosts"],
        json!(["models.example.com", "172.20.0.1"]),
        "{config}"
    );

    // An HTTPS endpoint needs no trust.
    let https = text.replace(
        "http://172.20.0.1:11446/v1",
        "https://inference.example.com/v1",
    );
    assert_ne!(https, text);
    let config = project(&https);
    assert_eq!(config["harness"]["settings"], json!({}), "{config}");

    // Pi declares the setting too, for its Relay gateway.
    let pi = project(include_str!("../../../examples/fabric-pi.yaml"));
    assert_eq!(
        pi["harness"]["settings"]["insecure_http_model_hosts"],
        json!(["172.20.0.1"]),
        "{pi}"
    );

    // Hermes declares no such setting, and Fabric rejects undeclared settings.
    let hermes = project(include_str!("../../../examples/fabric-hermes.yaml"));
    assert!(
        hermes["models"]["default"]["base_url"]
            .as_str()
            .is_some_and(|url| url.starts_with("http://")),
        "{hermes}"
    );
    assert_eq!(hermes["harness"]["settings"], json!({}), "{hermes}");
}

#[test]
fn declared_model_extensions_get_the_provider_api_and_authored_fields() {
    // Pi declares `api`, `context_window`, and `max_tokens` as model extensions.
    let pi = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../examples/fabric-pi.yaml").as_slice(),
    )
    .unwrap();
    let model = &nemoclaw_sdk::fabric_config::for_sandbox(&pi, pi.sandbox("assistant").unwrap())
        .unwrap()["models"]["default"];
    assert_eq!(model["api"], "openai-completions", "{model}");
    assert_eq!(model["context_window"], 32768, "{model}");
    assert_eq!(model["max_tokens"], 4096, "{model}");

    // OpenClaw declares no model `api`, so none is sent.
    let text = include_str!("../../../examples/openclaw.yaml");
    let openclaw = nemoclaw_sdk::config::Document::parse(text.as_bytes()).unwrap();
    let config =
        nemoclaw_sdk::fabric_config::for_sandbox(&openclaw, openclaw.sandbox("assistant").unwrap())
            .unwrap();
    assert!(config["models"]["default"].get("api").is_none(), "{config}");

    // Extensions cannot replace a field the deployment sets.
    let reserved = text.replace(
        "                maxTokens: 8192\n",
        "                maxTokens: 8192\n                extensions:\n                  base_url: https://elsewhere.example.com/v1\n",
    );
    assert_ne!(reserved, text);
    let reserved = nemoclaw_sdk::config::Document::parse(reserved.as_bytes()).unwrap();
    assert!(
        nemoclaw_sdk::fabric_config::for_sandbox(&reserved, reserved.sandbox("assistant").unwrap())
            .is_err()
    );
}

#[test]
fn routes_set_the_harness_provider_and_sampling() {
    let text = include_str!("../../../examples/openclaw.yaml");
    let plain = nemoclaw_sdk::config::Document::parse(text.as_bytes()).unwrap();
    let model =
        &nemoclaw_sdk::fabric_config::for_sandbox(&plain, plain.sandbox("assistant").unwrap())
            .unwrap()["models"]["default"];
    // Without them, the provider is the inference provider's API family and
    // no sampling is sent.
    assert_eq!(model["provider"], "openai", "{model}");
    assert!(model.get("temperature").is_none(), "{model}");
    assert!(model.get("top_p").is_none(), "{model}");

    let tuned = text.replace(
        "                maxTokens: 8192\n",
        "                maxTokens: 8192\n                harnessProvider: custom\n                temperature: 0.2\n                topP: 0.9\n",
    );
    assert_ne!(tuned, text);
    let tuned = nemoclaw_sdk::config::Document::parse(tuned.as_bytes()).unwrap();
    let model =
        &nemoclaw_sdk::fabric_config::for_sandbox(&tuned, tuned.sandbox("assistant").unwrap())
            .unwrap()["models"]["default"];
    assert_eq!(model["provider"], "custom", "{model}");
    assert_eq!(model["temperature"], 0.2, "{model}");
    assert_eq!(model["top_p"], 0.9, "{model}");
    assert_eq!(model["max_tokens"], 8192, "{model}");
}
